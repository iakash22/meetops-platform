-- #423: atomic insert-once for outbox events that need dedupe (transcription delayed alerts).
-- Additive and minimal: one nullable column (no default, no rewrite, existing rows stay NULL) and one unique index.
-- NULLs are distinct, so existing and future events without a key are unaffected.
-- Writers use INSERT ... ON CONFLICT DO NOTHING on (org_id, dedupe_key) instead of check-then-write.
-- Rollback: DROP INDEX "outbox_events_org_id_dedupe_key_key"; ALTER TABLE "outbox_events" DROP COLUMN "dedupe_key";
-- Production note: on a populated production DB, build this index with CREATE UNIQUE INDEX CONCURRENTLY in its own
-- non-transactional migration (CONCURRENTLY cannot run inside a transaction), so writes to outbox_events are not
-- blocked while it builds. The plain CREATE UNIQUE INDEX below is fine for dev/staging and small tables.
ALTER TABLE "outbox_events" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "outbox_events_org_id_dedupe_key_key" ON "outbox_events"("org_id", "dedupe_key");
