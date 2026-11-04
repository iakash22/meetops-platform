# Outbox dedupe key index: recovery after a failed build

Migration `20261103200100_outbox_dedupe_key_index` (PR #423) builds the unique index
`outbox_events_org_id_dedupe_key_key` on `outbox_events (org_id, dedupe_key)` with `CREATE UNIQUE INDEX CONCURRENTLY`.
The insert-once transcription-delayed alert depends on it (`INSERT ... ON CONFLICT DO NOTHING`). NULL keys stay
distinct and never conflict.

Do not edit the migration file. Prisma checksums the whole file, so any change shows up as drift in every environment
that already applied it. This runbook holds the recovery steps instead.

## When to use this

`prisma migrate deploy` failed or was interrupted on this migration. A failed `CREATE INDEX CONCURRENTLY` leaves an
**INVALID** index behind, and the migration is recorded as failed. The usual cause is existing duplicate
`(org_id, dedupe_key)` rows.

## How to run it

- Run as the **migrator role**. Forced RLS hides other organizations' rows from the app role.
- Run **each statement separately in autocommit mode**, never inside a transaction. `DROP INDEX CONCURRENTLY` and
  `CREATE INDEX CONCURRENTLY` refuse to run in a transaction block.

## Steps

1. Find duplicate `(org_id, dedupe_key)` rows:

   ```sql
   SELECT org_id, dedupe_key, count(*), array_agg(status ORDER BY created_at) AS statuses
   FROM "outbox_events" WHERE dedupe_key IS NOT NULL
   GROUP BY org_id, dedupe_key HAVING count(*) > 1;
   ```

2. Delete only safe duplicates. For each key, keep one row: an unpublished row (`pending`, `failed` or
   `processing`) first, the oldest of those, otherwise the oldest published row. Never delete a row the relay is
   holding (status `processing`):

   ```sql
   DELETE FROM "outbox_events" o USING (
     SELECT id, status, row_number() OVER (
       PARTITION BY org_id, dedupe_key
       ORDER BY (status = 'published'), created_at, id
     ) AS rn
     FROM "outbox_events" WHERE dedupe_key IS NOT NULL
   ) d
   WHERE o.id = d.id AND d.rn > 1 AND d.status <> 'processing';
   ```

   Run step 1 again. Any duplicates left are rows the relay is processing; wait for the relay, then repeat.

3. Drop the invalid index:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS "outbox_events_org_id_dedupe_key_key";
   ```

4. Mark the migration rolled back, then deploy again:

   ```bash
   pnpm --filter @meetops/database exec prisma migrate resolve --rolled-back 20261103200100_outbox_dedupe_key_index
   pnpm --filter @meetops/database exec prisma migrate deploy
   ```

## Rollback

To remove the index on purpose:

```sql
DROP INDEX CONCURRENTLY "outbox_events_org_id_dedupe_key_key";
```
