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

`pgvector/pgvector:pg16` with the PR #7 names: `POSTGRES_USER=meetops` (bootstrap superuser only), `POSTGRES_DB=meetops`, port 5432.

## Roles (cluster level, created before migrations)

`pnpm --filter @meetops/database db:roles` (`scripts/create-db-roles.ts`; or `create-db-roles.sh` / `bootstrap-roles.sql` with psql), run with a superuser `ADMIN_DATABASE_URL`. It is idempotent: it creates or updates the roles, creates the `meetops` DB owned by the migrator, and runs `CREATE EXTENSION vector`, because pgvector is not a trusted extension.

| Role               | Attributes                                                                                                                                                                 | Used by                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `meetops_migrator` | LOGIN, NOSUPERUSER, NOBYPASSRLS; owns DB/schema/tables                                                                                                                     | `migrate deploy`, seed (optional) |
| `meetops_app`      | LOGIN, NOSUPERUSER, **NOBYPASSRLS**, NOCREATEDB/ROLE; DML grants only                                                                                                      | API / worker runtime              |
| `meetops_relay`    | LOGIN, NOBYPASSRLS, NOSUPERUSER; no table privileges, EXECUTE on `relay_claim_outbox_events(limit)` and `relay_complete_outbox_event(id, published, error, retry_at)` only | outbox relay process              |

Migrations assert these attributes. A migration fails if `meetops_app` is superuser or BYPASSRLS, or if a required role is missing.

## Env vars

| Var                                                                                      | Value (CI)                                                                           | Purpose                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| `ADMIN_DATABASE_URL`                                                                     | `postgresql://meetops:change-me-local-dev@localhost:5432/meetops`                    | role bootstrap only            |
| `MEETOPS_MIGRATOR_DB_PASSWORD` / `MEETOPS_APP_DB_PASSWORD` / `MEETOPS_RELAY_DB_PASSWORD` | CI secrets or random values                                                          | bootstrap                      |
| `MIGRATION_DATABASE_URL`                                                                 | `postgresql://meetops_migrator:$MEETOPS_MIGRATOR_DB_PASSWORD@localhost:5432/meetops` | Prisma `directUrl` (migrate)   |
| `DATABASE_URL`                                                                           | `postgresql://meetops_app:$MEETOPS_APP_DB_PASSWORD@localhost:5432/meetops`           | runtime + seed                 |
| `RLS_TEST_APP_URL`                                                                       | same as `DATABASE_URL`                                                               | live tests                     |
| `RLS_TEST_OWNER_URL`                                                                     | same as `MIGRATION_DATABASE_URL`                                                     | live tests (fixtures, catalog) |
| `RLS_TEST_RELAY_URL`                                                                     | `postgresql://meetops_relay:$MEETOPS_RELAY_DB_PASSWORD@localhost:5432/meetops`       | live relay tests               |

Without these vars the live suites are skipped. Unit tests still run.

## Steps

```bash
pnpm install --frozen-lockfile
pnpm --filter @meetops/database db:roles            # cross-platform, no psql needed
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

## Notes from live verification (P1-DB-3)

- Roles can come from DevOps' `infra/compose/postgres/initdb/10-meetops-roles.sh` (app + migrator only) or
  from `pnpm db:roles`; both are idempotent and the migrations never `ALTER ROLE`. If `meetops_relay` is
  created after `migrate deploy`, `pnpm db:roles` (with `MEETOPS_RELAY_DB_PASSWORD`) applies its outbox grants.
- Drift: `migrate diff --from-url $MIGRATION_DATABASE_URL --to-schema-datamodel` and
  `--from-migrations ... --to-url` both exit 0. `--from-migrations --to-schema-datamodel --shadow-database-url`
  reports only `CREATE EXTENSION IF NOT EXISTS "vector"` (a Prisma 5.22 quirk with a pre-created
  extension; it is a no-op), so CI should use the two checks that exit 0.
- Global (NULL-org) audit events are insert-only and invisible to the app, so write them with
  `auditEvent.createMany` (Prisma `create` uses RETURNING and is refused by RLS).
- Upgrade path: `test/fixtures/core-v1-sample.sql` holds PR #6-shape data; apply the init migration,
  `migrate resolve --applied 20261021000000_init_core_schema`, load the fixture, `migrate deploy`.
- Backfills in migrations lift FORCE RLS on the touched tables for the statement and re-force it
  in the same transaction (FORCE RLS also binds the owner, which has no org context).

## Security review fixes (PR #35)

- `accept_invitation`: re-accepting an existing/soft-deleted membership now takes the invitation's role.
- `lookup_invitation_by_token_hash`: returns only pending, unexpired, non-revoked, non-deleted invites;
  fields `id, org_id, email, role, expires_at` (email kept so the accept UI can show the invited address).
- `audit_events`: BEFORE UPDATE/DELETE/TRUNCATE trigger refuses changes for every role. Escape hatch
  only for a migration running as `meetops_migrator` with `SET LOCAL meetops.audit_maintenance = 'on'`.
  The FK action from deleting a user (actor_id to NULL) is the one allowed update. The app inserts only
  rows for its current org; global auth events go through `record_global_auth_event(...)` (allowlisted
  actions and target types, metadata object of at most 4 KB).
- Relay: definer functions instead of table access (a CHECK cannot prove a jsonb payload has no PII);
  the relay has no table privileges and no BYPASSRLS.
- Backfill windows: Prisma sends each migration file as one multi-statement simple query, which Postgres
  runs as one implicit transaction (statements after an explicit COMMIT form another one), so a failure rolls back the NO FORCE too. Verified live on pg16 with a probe migration: NO FORCE, then 1/0, left the table forced, both with and without a preceding BEGIN/COMMIT.
  `20261022034000_assert_forced_rls` fails the deploy if any RLS table is not forced.

## Architecture re-review fixes (#35 at 915f6b0)

- **B1, accept_invitation and active members** (`20261022040000_accept_invitation_active_member`): accepting an invitation never changes an _active_ membership. The call raises `already_member` (SQLSTATE `P0001`), so a sole owner who accepts a viewer invite stays owner and the org keeps its owner. A soft-deleted membership is revived with the invitation's role, and a new membership is inserted with the invitation's role as before.
  **Decision:** the invitation stays `pending`. The exception rolls back the whole call: the invite is not consumed and no audit row is written, so an admin can still see and revoke it, or it expires. The API should also refuse to invite an address that is already an active member (BE/#53).
- **Audit maintenance hatch** (`20261022041000_audit_hatch_session_user`): the hatch now requires `session_user = 'meetops_migrator'` plus `meetops.audit_maintenance=on`. A migrator-owned SECURITY DEFINER function called by the app (where `current_user` is the migrator) cannot open it. A superuser session can't either; superusers can disable the trigger explicitly if they truly need to. Live test: "a migrator-owned SECURITY DEFINER function cannot open the hatch".
- **Data-only restore:** `audit_events` has BEFORE UPDATE/DELETE/TRUNCATE triggers. For a `pg_restore --data-only` into an existing schema, run it as a superuser with `--disable-triggers`, or restore the full schema plus data into an empty database.
- **Live tests need a throwaway database.** They leave fixture orgs and users behind (for example `ex-owner-*`, `multi-*`, `sole-*`). Cleanup isn't possible by design: audit rows are append-only and reference those orgs. Run them only against a disposable DB, as CI and `live.sh` do.
- The forced-RLS check runs after every deploy in the live suite ("every table with RLS enabled is forced"), not only in migration 034000.
