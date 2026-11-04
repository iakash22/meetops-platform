-- #423: unique (org_id, dedupe_key) for INSERT ... ON CONFLICT DO NOTHING; NULL keys stay distinct.
-- Single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Prisma Migrate does
-- not wrap a PostgreSQL migration in an explicit transaction, and a file with one statement is not an implicit
-- multi-statement block, so it does not block writes to outbox_events while it builds.
-- If a build is interrupted it leaves an INVALID index: DROP INDEX CONCURRENTLY "outbox_events_org_id_dedupe_key_key";
-- then `prisma migrate resolve --rolled-back 20261103200100_outbox_dedupe_key_index` and deploy again.
-- Rollback: DROP INDEX CONCURRENTLY "outbox_events_org_id_dedupe_key_key";
CREATE UNIQUE INDEX CONCURRENTLY "outbox_events_org_id_dedupe_key_key" ON "outbox_events"("org_id", "dedupe_key");
