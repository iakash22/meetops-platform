-- Security review (3): narrow meetops_relay. Chosen: definer functions instead of table access.
-- Why not "ids-only payload + CHECK": payload shape is owned by producers and a CHECK can't prove a
-- jsonb holds no PII. With functions the relay never gets table privileges at all; it can only claim
-- due pending events (only the columns needed to publish) and report the outcome. It therefore no
-- longer needs BYPASSRLS either (scripts now create it NOBYPASSRLS).
DROP POLICY IF EXISTS definer_outbox_access ON "outbox_events";
CREATE POLICY definer_outbox_access ON "outbox_events" TO meetops_migrator USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.relay_claim_outbox_events(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, org_id uuid, aggregate_type text, aggregate_id uuid, event_type text, payload jsonb, attempts integer)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.outbox_events o
  SET status = 'processing', attempts = o.attempts + 1, updated_at = now()
  WHERE o.id IN (
    SELECT c.id FROM public.outbox_events c
    WHERE c.status = 'pending' AND c.available_at <= now()
    ORDER BY c.available_at, c.id
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.org_id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.attempts
$$;

CREATE OR REPLACE FUNCTION public.relay_complete_outbox_event(
  p_id uuid, p_published boolean, p_error text DEFAULT NULL, p_retry_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.outbox_events o
  SET status = CASE WHEN p_published THEN 'published'::"OutboxStatus"
                    WHEN p_retry_at IS NOT NULL THEN 'pending'::"OutboxStatus"
                    ELSE 'failed'::"OutboxStatus" END,
      published_at = CASE WHEN p_published THEN now() ELSE o.published_at END,
      last_error = CASE WHEN p_published THEN NULL ELSE left(p_error, 1000) END,
      available_at = COALESCE(p_retry_at, o.available_at),
      updated_at = now()
  WHERE o.id = p_id AND o.status = 'processing';
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.relay_claim_outbox_events(integer) OWNER TO meetops_migrator;
ALTER FUNCTION public.relay_complete_outbox_event(uuid, boolean, text, timestamptz) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.relay_claim_outbox_events(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.relay_complete_outbox_event(uuid, boolean, text, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM meetops_relay', current_schema());
    GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) TO meetops_relay;
    GRANT EXECUTE ON FUNCTION public.relay_complete_outbox_event(uuid, boolean, text, timestamptz) TO meetops_relay;
  ELSE
    RAISE NOTICE 'meetops_relay not found; run pnpm db:roles with MEETOPS_RELAY_DB_PASSWORD to grant relay functions';
  END IF;
END
$$;
