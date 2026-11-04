-- #423: insert-once key for outbox events that need dedupe (transcription delayed alerts).
-- Additive: one nullable column, no default, no table rewrite; existing rows stay NULL.
-- The unique index on (org_id, dedupe_key) is built CONCURRENTLY in the next migration
-- (20261103200100_outbox_dedupe_key_index).
-- Rollback: ALTER TABLE "outbox_events" DROP COLUMN "dedupe_key";
ALTER TABLE "outbox_events" ADD COLUMN "dedupe_key" TEXT;
