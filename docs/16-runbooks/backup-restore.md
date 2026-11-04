# Backup and restore: Postgres, object storage and Redis

Status: draft runbook (P9 item #10, `docs/p9/remaining-work.md`). Hosting, retention targets and the alert destination
are **needs-owner** (Akash). Commands are written for the dev compose stack (`infra/compose/compose.dev.yml`) and for
generic managed services; adjust names to the chosen host.

Never paste passwords, keys or connection strings into tickets, chat or logs. Load them from the secrets dir or the
secret manager (ADR-016) into env vars in the shell that runs the command.

## What holds state

| Store                                    | Holds                                                                                     | Loss impact                                   | Backup                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Postgres 16 + pgvector (`postgres-data`) | All tenant data (RLS on `organizationId`), transcripts, tasks, audit, embeddings, consent | Critical: system of record                    | PITR (base backup + WAL) in prod; nightly `pg_dump -Fc` copy |
| Object storage (MinIO dev, R2/S3 prod)   | Recordings, chunks, uploads (tenant-prefixed keys)                                        | High: media cannot be recreated               | Bucket versioning + replication, or `mc mirror`              |
| Redis 7 (`redis-data`, AOF on)           | BullMQ queues, rate-limit windows, one-time tokens, leases, revocation pub/sub            | Medium: in-flight jobs and short-lived tokens | AOF + RDB snapshots; recoverable, not a system of record     |

Targets to confirm with the owner: Postgres RPO ≤ 5 min and RTO ≤ 1 h; object storage RPO ≤ 24 h; Redis best effort.

## Postgres

### Backup

- **Production:** the host's PITR (WAL archiving plus a daily base backup, kept ≥ 14 days), encrypted, stored in a
  different account or region from the primary.
- **Logical copy (all environments):**

  ```bash
  # Use the owner/migrator role, never the RLS-bound app role (it would dump only one org's rows).
  pg_dump --format=custom --no-owner --no-privileges \
    --file="meetops-$(date +%Y%m%dT%H%M%S).dump" "$DATABASE_ADMIN_URL"
  ```

  Dev compose: `docker compose -f infra/compose/compose.dev.yml exec -T postgres pg_dump -U postgres -Fc meetops > meetops.dump`.

- Store with each dump: the deployed git SHA, the latest applied migration
  (`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;`) and a checksum.

### Restore

1. Stop writers: scale API, worker and realtime to 0 so no job writes during the restore.
2. Restore into a **new** database, never over the live one:

   ```bash
   createdb "$RESTORE_DB"
   pg_restore --no-owner --no-privileges --dbname="$RESTORE_DB" meetops.dump
   ```

   For PITR, restore the host snapshot to a time just before the incident.

3. Re-create roles and grants: `pnpm db:roles` (RLS stays forced).
4. Bring the schema to the deployed version: `pnpm db:migrate` (deploy mode only, never `migrate dev`).
5. Check that `vector` is in `pg_extension`, that RLS is forced on tenant tables
   (`SELECT relname FROM pg_class WHERE relrowsecurity AND relforcerowsecurity;`) and that row counts for
   organizations, meetings and transcripts look right.
6. Point `DATABASE_URL` at the restored database, start the API, then the worker. `/ready` must be green.

## Object storage (S3, R2, MinIO)

### Backup

- **Production:** bucket versioning on, with a lifecycle rule for noncurrent versions (≥ 30 days, aligned with
  ADR-019). Replicate to a second bucket in another region or account. Server-side encryption on.
- **Any S3 API, including MinIO:**

  ```bash
  mc alias set src "$SRC_ENDPOINT" "$SRC_ACCESS_KEY" "$SRC_SECRET_KEY"
  mc alias set bkp "$BKP_ENDPOINT" "$BKP_ACCESS_KEY" "$BKP_SECRET_KEY"
  mc mirror --preserve --overwrite src/meetops-dev bkp/meetops-dev-backup
  ```

### Restore

1. Restore into a new bucket, or restore object versions in place for a partial loss.
2. Spot-check recent recordings per org: every `file_objects` row should have its object. Report missing objects as
   data loss.
3. Point `STORAGE_BUCKET` / `STORAGE_ENDPOINT` at the restored bucket and restart API and worker.
4. Media deleted for retention or consent (ADR-019, ADR-020) must not come back: re-run the retention and consent
   purge (`meeting-consent-maintenance.md`) before downloads are re-enabled.

## Redis

Postgres is the source of truth for work that matters (notification outbox, transcript and AI stores).

### Backup

- AOF is on (`--appendonly yes`). In production also keep hourly RDB snapshots (`save 3600 1`) or host snapshots.
- Manual: `redis-cli BGSAVE`, then copy `dump.rdb` and the AOF directory from `/data`.

### Restore

1. Stop API and worker.
2. Put `dump.rdb` / the AOF into a fresh Redis data dir and keep the same ACL file (`redis_acl` secret).
3. Start Redis, then the worker, then the API.
4. If Redis is lost with no usable snapshot:
   - rate-limit windows and lockouts reset (acceptable);
   - one-time tokens held in Redis stop working, so users request new verify/reset links;
   - the notifications outbox re-enqueues by itself; re-enqueue transcription/AI jobs for recordings still
     `processing`;
   - sessions and revocations in Postgres are unaffected.

## Restore drill (quarterly and before each major release)

Scripts: `scripts/db-backup.sh` and `scripts/db-restore-drill.sh` (tests: `tests/ci/backup-drill.test.sh`).
Both take the connection **only from libpq env** (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSFILE`), never from argv, so
no password reaches `ps`, history or logs.

1. **Back up** with the owner/migrator role (never the RLS-bound app role):

   ```bash
   PGHOST=... PGUSER=... PGPASSFILE=~/.pgpass scripts/db-backup.sh --db meetops --out backups/
   ```

   Writes `meetops-<db>-<UTC>.dump` (`pg_dump -Fc`) and `.meta` (sha256, git SHA, latest applied Prisma migration,
   forced-RLS table count, exact row count per public table), both `0600`. `backups/` is gitignored.

2. **Copy the dump to a local drill server** (a scratch Postgres 16 + pgvector, e.g. `pgvector/pgvector:pg16`
   with `--network host -c port=55439`). The drill refuses a non-local `PGHOST`.

3. **Run the drill:**

   ```bash
   PGHOST=127.0.0.1 PGPORT=55439 PGUSER=postgres PGPASSFILE=... \
     scripts/db-restore-drill.sh --dump backups/meetops-meetops-<UTC>.dump [--target drill_q4] [--keep]
   ```

   It verifies the checksum (before restoring), restores into a **new** `drill_*` database (it refuses an existing
   one or any other name), and checks pgvector, the forced-RLS table count, the latest migration and every table's
   row count against `.meta`. It prints the restore time (RTO input) and backup age (RPO input), then drops the
   scratch database unless `--keep`. Exit: 0 PASS, 1 FAIL, 2 usage, 3 missing/mismatched tools, 4 refused.

   **Client version:** `pg_restore` must not be newer than the server (v17 tools emit `SET transaction_timeout`,
   which v16 rejects; the drill exits 3). Set `PG_BIN` to v16 client tools, or run inside the server image. Use the
   same tools for the backup.

4. For a full-stack drill, keep the database (`--keep`), point a staging stack at it, run `pnpm db:migrate`, sign
   in as a seeded test user and play a recording (object-storage copy restored as above).
5. Record start/finish (measured RTO), backup age (measured RPO), problems and the git SHA in the drill log; file
   follow-ups for anything that missed the targets.

Run the script tests against a throwaway server:

```bash
PGHOST=127.0.0.1 PGPORT=55439 PGUSER=postgres PGPASSFILE=... DRILL_TEST_CONTAINER=<container> \
  bash tests/ci/backup-drill.test.sh
```

## Open owner decisions

- Hosting for Postgres PITR and object-storage replication, and the backup account/region.
- Backup retention vs ADR-019 media retention (backups must not keep deleted media longer than policy allows).
- Where backup-failure alerts go (shared with P9 item #13).
