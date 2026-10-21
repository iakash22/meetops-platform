# Live database verification (CI spec for QA / DevOps)

Owner: Database agent. DevOps owns `.github/workflows`; copy `ci-live-db.example.yml` (next to this file) into a workflow job.

## What it proves
- All Prisma migrations apply from empty on real Postgres 16 + pgvector (`prisma migrate deploy`).
- No drift between the migrations and `schema.prisma` (`prisma migrate diff --from-url … --exit-code`).
- Seed runs as `meetops_app` under forced RLS, and can be re-run safely.
- Live security tests (`test/rls.live.test.ts`):
  - XT-26: no org context returns 0 rows.
  - XT-27: writing another org's row with context A fails WITH CHECK.
  - XT-28: the context does not leak across pooled transactions.
  - XT-29: catalog check that every `org_id` table has RLS enabled and forced, with a policy.
  - Invitation definer functions.
  - `meetops_relay` privilege limits.

## Service
`pgvector/pgvector:pg16`, superuser `postgres` (CI-only password), port 5432.

## Roles (cluster level, created before migrations)
`scripts/bootstrap-roles.sql`, run as superuser. It is idempotent: it creates or updates the roles, creates the `meetops` DB owned by the migrator, and runs `CREATE EXTENSION vector`, because pgvector is not a trusted extension.

| Role | Attributes | Used by |
| --- | --- | --- |
| `meetops_migrator` | LOGIN, NOSUPERUSER, NOBYPASSRLS; owns DB/schema/tables | `migrate deploy`, seed (optional) |
| `meetops_app` | LOGIN, NOSUPERUSER, **NOBYPASSRLS**, NOCREATEDB/ROLE; DML grants only | API / worker runtime |
| `meetops_relay` | LOGIN, **BYPASSRLS**, NOSUPERUSER; `SELECT` + `UPDATE(status, attempts, last_error, available_at, published_at, updated_at)` on `outbox_events` only | outbox relay process |

Migrations assert these attributes. A migration fails if `meetops_app` is superuser or BYPASSRLS, or if a required role is missing.

## Env vars
| Var | Value (CI) | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/postgres` | role bootstrap only |
| `MIGRATOR_PASSWORD` / `APP_PASSWORD` / `RELAY_PASSWORD` | CI secrets or random values | bootstrap |
| `MIGRATION_DATABASE_URL` | `postgresql://meetops_migrator:$MIGRATOR_PASSWORD@localhost:5432/meetops` | Prisma `directUrl` (migrate) |
| `DATABASE_URL` | `postgresql://meetops_app:$APP_PASSWORD@localhost:5432/meetops` | runtime + seed |
| `RLS_TEST_APP_URL` | same as `DATABASE_URL` | live tests |
| `RLS_TEST_OWNER_URL` | same as `MIGRATION_DATABASE_URL` | live tests (fixtures, catalog) |
| `RLS_TEST_RELAY_URL` | `postgresql://meetops_relay:$RELAY_PASSWORD@localhost:5432/meetops` | live relay tests |

Without these vars the live suites are skipped. Unit tests still run.

## Steps
```bash
pnpm install --frozen-lockfile
pnpm --filter @meetops/database db:bootstrap        # needs psql (postgresql-client)
pnpm --filter @meetops/database db:migrate:deploy
pnpm --filter @meetops/database exec prisma migrate diff \
  --from-url "$MIGRATION_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
pnpm --filter @meetops/database db:seed
pnpm --filter @meetops/database db:seed             # idempotency
pnpm --filter @meetops/database test:live
```

## Design notes
- **Policies** compare `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. Live testing found that after a transaction-local `set_config()` ends, Postgres resets the custom setting on that connection to `''`, not NULL. `''::uuid` then raised 22P02 instead of returning 0 rows; `NULLIF` keeps the policy fail-closed.
- **Invitations**: `lookup_invitation_by_token_hash(text)` and `accept_invitation(text, uuid)` are `SECURITY DEFINER`, owned by `meetops_migrator`, with `SET search_path = public, pg_temp`. `EXECUTE` is revoked from PUBLIC and granted only to `meetops_app`. FORCE RLS also binds table owners, so narrowly scoped `definer_*` policies `TO meetops_migrator` let the functions work. The migrator already owns these tables, so this grants nothing new. Accept checks pending status, expiry, and that the invitee's `users.email` matches (case-insensitive). It then upserts the membership, marks the invitation accepted, and writes an `audit_events` row. All failures return the same `invitation_invalid` error (P0002), so callers can't tell which check failed.
- **Outbox relay**: I chose a dedicated `meetops_relay` role over looping per org. Polling every org would mean scanning N orgs per tick and opening a context per org, and new orgs would be picked up late. One role with BYPASSRLS is limited by table and column privileges to reading `outbox_events` and updating delivery state. It cannot insert or delete events, change payloads, or read any other table. BYPASSRLS needs a superuser, so infra creates the role; the migration only grants privileges, and skips with a NOTICE if the role is absent. Auditing: enable `pgaudit` (or `log_statement`) for `meetops_relay` in deployed environments; this is an infra follow-up.
