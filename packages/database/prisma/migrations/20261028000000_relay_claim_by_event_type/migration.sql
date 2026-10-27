-- Relay claims by event type. The notification relay must not claim (and so must not consume) outbox events it does
-- not handle, so future consumers (e.g. auth.new_location_signin) still find them pending. Adds an overload that
-- only claims the given event types; same definer/least-privilege model as 20261022033000.
CREATE OR REPLACE FUNCTION public.relay_claim_outbox_events(p_limit integer, p_event_types text[])
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
      AND c.event_type = ANY (COALESCE(p_event_types, ARRAY[]::text[]))
    ORDER BY c.available_at, c.id
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.org_id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.attempts
$$;

ALTER FUNCTION public.relay_claim_outbox_events(integer, text[]) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION public.relay_claim_outbox_events(integer, text[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meetops_relay') THEN
    GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer, text[]) TO meetops_relay;
  ELSE
    RAISE NOTICE 'meetops_relay not found; run pnpm db:roles with MEETOPS_RELAY_DB_PASSWORD to grant relay functions';
  END IF;
END
$$;
