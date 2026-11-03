-- #423: atomic insert-once for outbox events that need dedupe (transcription delayed alerts).
-- Additive and minimal: one nullable column (no default, no rewrite, existing rows stay NULL) and one unique index.
-- NULLs are distinct, so existing and future events without a key are unaffected.
-- Writers use INSERT ... ON CONFLICT DO NOTHING on (org_id, dedupe_key) instead of check-then-write.
-- Rollback: DROP INDEX "outbox_events_org_id_dedupe_key_key"; ALTER TABLE "outbox_events" DROP COLUMN "dedupe_key";
ALTER TABLE "outbox_events" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "outbox_events_org_id_dedupe_key_key" ON "outbox_events"("org_id", "dedupe_key");
