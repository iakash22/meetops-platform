-- Phase 7: calendar background sync. Additive only.
--
-- calendar_events: provider events cached per calendar connection, written by the worker sweep and read by the API
-- (read-through with live fallback). Events that disappear from the provider inside a fully-synced window are
-- soft-cancelled (status 'cancelled'); the app role has no DELETE. Tenant isolation is forced.
--
-- calendar_connections gains a sync cursor (window last synced, failure count, next due time) and a SECURITY DEFINER
-- routing function for the cross-tenant sweep that returns identifiers only (same pattern as
-- integration_connections_due_for_refresh + definer_integration_routing_select).

ALTER TABLE "calendar_connections"
  ADD COLUMN "last_synced_at" TIMESTAMPTZ(3),
  ADD COLUMN "synced_from" TIMESTAMPTZ(3),
  ADD COLUMN "synced_to" TIMESTAMPTZ(3),
  ADD COLUMN "sync_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_sync_at" TIMESTAMPTZ(3);
ALTER TABLE "calendar_connections"
  ADD CONSTRAINT "calendar_connections_sync_failures_check" CHECK ("sync_failures" >= 0),
  ADD CONSTRAINT "calendar_connections_sync_window_check" CHECK (
    ("synced_from" IS NULL AND "synced_to" IS NULL) OR ("synced_from" IS NOT NULL AND "synced_to" > "synced_from"));
CREATE INDEX "calendar_connections_status_next_sync_at_idx" ON "calendar_connections"("status", "next_sync_at");

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "conference_url" TEXT,
    "html_link" TEXT,
    "organizer_email" TEXT,
    "attendee_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_events_org_id_id_key" ON "calendar_events"("org_id", "id");
CREATE UNIQUE INDEX "calendar_events_org_id_connection_id_provider_event_id_key" ON "calendar_events"("org_id", "connection_id", "provider_event_id");
CREATE INDEX "calendar_events_org_id_user_id_starts_at_idx" ON "calendar_events"("org_id", "user_id", "starts_at");
CREATE INDEX "calendar_events_org_id_connection_id_starts_at_idx" ON "calendar_events"("org_id", "connection_id", "starts_at");

ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_connection_id_fkey" FOREIGN KEY ("org_id", "connection_id") REFERENCES "calendar_connections"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_provider_check" CHECK ("provider" IN ('google')),
  ADD CONSTRAINT "calendar_events_status_check" CHECK ("status" IN ('confirmed', 'tentative', 'cancelled')),
  ADD CONSTRAINT "calendar_events_time_check" CHECK ("ends_at" >= "starts_at"),
  ADD CONSTRAINT "calendar_events_attendee_count_check" CHECK ("attendee_count" >= 0),
  ADD CONSTRAINT "calendar_events_provider_event_id_check" CHECK (btrim("provider_event_id") <> '' AND length("provider_event_id") <= 1024),
  ADD CONSTRAINT "calendar_events_title_len_check" CHECK (length("title") <= 1024),
  ADD CONSTRAINT "calendar_events_conference_url_check" CHECK ("conference_url" IS NULL OR "conference_url" ~ '^https://'),
  ADD CONSTRAINT "calendar_events_html_link_check" CHECK ("html_link" IS NULL OR "html_link" ~ '^https://');

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "calendar_events"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE "calendar_events" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "calendar_events" TO meetops_app;

-- Cross-tenant sweep routing: active connections whose next sync is due (never-synced first), ids only.
GRANT SELECT ON TABLE "calendar_connections" TO meetops_migrator;
DROP POLICY IF EXISTS definer_calendar_sync_select ON "calendar_connections";
CREATE POLICY definer_calendar_sync_select ON "calendar_connections"
  FOR SELECT
  TO meetops_migrator
  USING (status = 'active');

CREATE FUNCTION calendar_connections_due_for_sync(p_now timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, user_id uuid, provider text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.org_id, c.id, c.user_id, c.provider
  FROM public.calendar_connections c
  WHERE c.status = 'active'
    AND (c.next_sync_at IS NULL OR c.next_sync_at <= p_now)
  ORDER BY c.next_sync_at ASC NULLS FIRST, c.id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
ALTER FUNCTION calendar_connections_due_for_sync(timestamptz, integer) OWNER TO meetops_migrator;
REVOKE ALL ON FUNCTION calendar_connections_due_for_sync(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_connections_due_for_sync(timestamptz, integer) TO meetops_app;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS enabled but not forced on: %', bad;
  END IF;
END $$;
