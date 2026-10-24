# Runbook: dev wipe and reseed for `organizations/{organizationId}/` keys

**Scope:** local dev only (compose `infra/compose/compose.dev.yml`, MinIO + Postgres). Never staging/prod.
**When:** only after PR #82 (`feat(storage)!: organizations/{organizationId}/ object keys`) is merged into `integration/phase-1`.
**Hard preconditions:** the dev wipe runs **only after #82 is merged**. Each `--apply` run needs Akash's go-ahead,
confirmed separately for that run (an earlier approval does not carry over).

## Why wipe instead of migrate in dev

Dev data is disposable seed data. Rather than backfilling, we empty the dev bucket's objects, reset the
dev DB with the repo's Prisma migrations, and reseed. New uploads then use the #82 key layout.

## Existing repo commands used

| Purpose     | Command                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Start infra | `pnpm dev:infra:up` (compose; `minio-init` creates `$STORAGE_BUCKET`)                            |
| Stop infra  | `pnpm dev:infra:down`                                                                            |
| Migrations  | `pnpm --filter @meetops/database db:migrate:dev` / `db:migrate:deploy`                           |
| Seed        | `pnpm --filter @meetops/database db:seed` (`tsx prisma/seed.ts`)                                 |
| Reset       | none in repo (`db:reset` does not exist); script uses `prisma migrate reset --force --skip-seed` |

## Env (names only, from `.env.example`)

`NODE_ENV`, `DATABASE_URL`, `STORAGE_PROVIDER`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`,
`STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`. No values are printed by the script.

## Procedure

1. Confirm #82 is merged and your checkout is on latest `integration/phase-1`; `pnpm install`.
2. `pnpm dev:infra:up` and load `.env` into the shell (`set -a; . ./.env; set +a`).
3. Dry-run (default): `scripts/dev/storage-key-dev-reset.sh`
   - Refuses unless `NODE_ENV=development`, `STORAGE_PROVIDER=minio`, local `STORAGE_ENDPOINT`,
     bucket ending in `-dev`, and a local `DATABASE_URL` host.
   - Prints object counts (total, `org/`, `organizations/`) and what it would do.
4. Get Akash's direct approval, then apply:
   ```sh
   MEETOPS_ALLOW_DEV_WIPE=yes-wipe-dev scripts/dev/storage-key-dev-reset.sh --apply --confirm-dev-wipe="$STORAGE_BUCKET"
   ```
   It removes objects only (bucket kept), runs `prisma migrate reset`, then `db:seed`.
5. Verify new uploads:
   - Upload a recording via the web app/extension.
   - Re-run the dry-run: `org/` must be `0`, `organizations/` > 0.
   - `psql "$DATABASE_URL" -c "select count(*) from file_objects where storage_key like 'org/%';"` → `0`
   - `psql "$DATABASE_URL" -c "select count(*) from file_objects where storage_key not like 'organizations/' || org_id || '/%';"` → `0`

## Rollback

- Dev data is not recoverable after `--apply` (by design). If you need it, back it up first:
  `mc mirror meetopsdev/$STORAGE_BUCKET ./backup-bucket` and `pg_dump "$DATABASE_URL" > backup.sql`.
- Code rollback: revert #82 on `integration/phase-1` (via PR), then rerun this procedure so keys go back to `org/`.
- Worst case: `pnpm dev:infra:down`, remove the `minio-data`/postgres volumes, `pnpm dev:infra:up`, migrate, seed.
