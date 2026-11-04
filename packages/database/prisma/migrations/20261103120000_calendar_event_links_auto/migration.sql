-- Phase 7: calendar auto-link (worker, CALENDAR_AUTO_LINK_ENABLED, default off). Additive only.
--
-- source: who created the link. 'manual' (API, the default for every existing row) or 'auto' (worker sweep).
-- unlinked_at: a user removed the link. Unlinking is now a soft delete so the worker can tell "never linked" from
-- "the user removed it" and never recreate a link a user removed. Readers treat unlinked rows as absent; linking the
-- event again manually clears it. Disconnecting a calendar still hard-deletes the connection's rows.
-- RLS (forced, tenant_isolation) and grants on calendar_event_links are unchanged and cover the new columns.

ALTER TABLE "calendar_event_links"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "unlinked_at" TIMESTAMPTZ(3);

ALTER TABLE "calendar_event_links"
  ADD CONSTRAINT "calendar_event_links_source_check" CHECK ("source" IN ('manual', 'auto'));
