-- Phase 7: link calendar events to meetings. Additive only.
--
-- calendar_event_links: one row per (connection, provider event) the owner of that calendar connection linked to a
-- meeting of the same organization. Keyed by the provider event id (not calendar_events.id) so links work for both
-- live-read and worker-synced events. Composite tenant FKs to calendar_connections and meetings, so a link can never
-- point across organizations. Unlinking is a real DELETE (no secrets, no audit value in the row itself); disconnecting
-- the calendar removes the connection's links in the same transaction. Tenant isolation is forced.

-- CreateTable
CREATE TABLE "calendar_event_links" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "meeting_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_event_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_event_links_org_id_id_key" ON "calendar_event_links"("org_id", "id");
CREATE UNIQUE INDEX "calendar_event_links_org_id_connection_id_provider_event_id_key" ON "calendar_event_links"("org_id", "connection_id", "provider_event_id");
CREATE INDEX "calendar_event_links_org_id_meeting_id_idx" ON "calendar_event_links"("org_id", "meeting_id");

ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_org_id_connection_id_fkey" FOREIGN KEY ("org_id", "connection_id") REFERENCES "calendar_connections"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_org_id_meeting_id_fkey" FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calendar_event_links"
  ADD CONSTRAINT "calendar_event_links_provider_event_id_check" CHECK (btrim("provider_event_id") <> '' AND length("provider_event_id") <= 1024);

-- Tenant isolation, forced (canonical ADR-010 setting only; fail-closed when unset).
ALTER TABLE "calendar_event_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_event_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "calendar_event_links"
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
REVOKE TRUNCATE ON TABLE "calendar_event_links" FROM meetops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "calendar_event_links" TO meetops_app;

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
