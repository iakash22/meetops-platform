# @meetops/database

Prisma schema, migrations, seed and tenant-safe client for MeetOps (PostgreSQL 16 + pgvector).

## Public API

`createPrismaClient`, `getPrismaClient`, `disconnectPrismaClient`, `withOrgContext(organizationId, fn, { client?, userId?, timeoutMs? })`, plus the types `DatabaseClient`, `DatabaseTransaction` and `OrgContextOptions`. Every tenant query must run inside `withOrgContext`: forced RLS returns no rows without it.

## Roles and env

| Role                       | Purpose                                                                              | Env                                           |
| -------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `meetops_app`              | runtime (NOBYPASSRLS, DML only)                                                      | `DATABASE_URL`                                |
| `meetops_migrator`         | owns the schema; runs migrations                                                     | `MIGRATION_DATABASE_URL` (Prisma `directUrl`) |
| `meetops_relay` (optional) | outbox relay (BYPASSRLS; only SELECT plus delivery-column UPDATE on `outbox_events`) | relay service URL                             |

## Local setup

### 1. Start Postgres with pgvector

Use the DevOps compose stack (`infra/compose/compose.dev.yml`, PR #7) with the root `.env`:

```
POSTGRES_USER=meetops            # bootstrap superuser only; the app never connects as it
POSTGRES_PASSWORD=change-me-local-dev
POSTGRES_DB=meetops
POSTGRES_PORT=5432
```

```bash
pnpm dev:infra:up
```

Or run it standalone: `docker run -d --name meetops-db -e POSTGRES_USER=meetops -e POSTGRES_PASSWORD=change-me-local-dev -e POSTGRES_DB=meetops -p 127.0.0.1:5432:5432 pgvector/pgvector:pg16`.

### 2. Create the roles and database (idempotent; re-run to rotate passwords)

The scripts create or update LOGIN roles `meetops_app` and `meetops_migrator` (and optionally `meetops_relay`), hand the `meetops` DB and `public` schema to the migrator, and enable pgvector. They need these env vars. They fail if a required one is unset, and never print passwords.

| Var                            | Required                                    |
| ------------------------------ | ------------------------------------------- |
| `ADMIN_DATABASE_URL`           | yes: superuser (`POSTGRES_USER`) connection |
| `MEETOPS_APP_DB_PASSWORD`      | yes                                         |
| `MEETOPS_MIGRATOR_DB_PASSWORD` | yes                                         |
| `MEETOPS_RELAY_DB_PASSWORD`    | no: when set, also creates `meetops_relay`  |
| `MEETOPS_DB_NAME`              | no: default `meetops`                       |

**Linux / macOS (bash/zsh):**

```bash
export ADMIN_DATABASE_URL='postgresql://meetops:change-me-local-dev@localhost:5432/meetops'
read -rs MEETOPS_APP_DB_PASSWORD && export MEETOPS_APP_DB_PASSWORD
read -rs MEETOPS_MIGRATOR_DB_PASSWORD && export MEETOPS_MIGRATOR_DB_PASSWORD
pnpm --filter @meetops/database db:roles        # TypeScript, no psql required
# or, with psql installed:
pnpm --filter @meetops/database db:roles:sh     # scripts/create-db-roles.sh
```

**Windows (PowerShell):**

```powershell
$env:ADMIN_DATABASE_URL = 'postgresql://meetops:change-me-local-dev@localhost:5432/meetops'
$env:MEETOPS_APP_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'app password' -AsSecureString)))
$env:MEETOPS_MIGRATOR_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'migrator password' -AsSecureString)))
pnpm --filter @meetops/database db:roles
```

Variants:

- `scripts/create-db-roles.ts` works on any OS and sends passwords as bind parameters.
- `scripts/create-db-roles.sh` (POSIX sh + psql) feeds variables over stdin.
- `scripts/bootstrap-roles.sql` is the raw psql file both use; its header documents direct use.

### 3. Connection URLs, migrate, seed, test

Local dev placeholders (change them; percent-encode special characters in URLs):

| Var                                 | Example                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `MEETOPS_APP_DB_PASSWORD`           | `change-me-app-local`                                                           |
| `MEETOPS_MIGRATOR_DB_PASSWORD`      | `change-me-migrator-local`                                                      |
| `DATABASE_URL` (app, RLS enforced)  | `postgresql://meetops_app:change-me-app-local@localhost:5432/meetops`           |
| `MIGRATION_DATABASE_URL` (migrator) | `postgresql://meetops_migrator:change-me-migrator-local@localhost:5432/meetops` |

Inside the compose network the host is `postgres` instead of `localhost`.

```bash
export DATABASE_URL='postgresql://meetops_app:change-me-app-local@localhost:5432/meetops'
export MIGRATION_DATABASE_URL='postgresql://meetops_migrator:change-me-migrator-local@localhost:5432/meetops'
pnpm --filter @meetops/database db:migrate:deploy
pnpm --filter @meetops/database db:seed
RLS_TEST_APP_URL=$DATABASE_URL RLS_TEST_OWNER_URL=$MIGRATION_DATABASE_URL pnpm --filter @meetops/database test:live
```

```powershell
$env:DATABASE_URL = 'postgresql://meetops_app:change-me-app-local@localhost:5432/meetops'
$env:MIGRATION_DATABASE_URL = 'postgresql://meetops_migrator:change-me-migrator-local@localhost:5432/meetops'
pnpm --filter @meetops/database db:migrate:deploy
pnpm --filter @meetops/database db:seed
$env:RLS_TEST_APP_URL = $env:DATABASE_URL; $env:RLS_TEST_OWNER_URL = $env:MIGRATION_DATABASE_URL
pnpm --filter @meetops/database test:live
```

The CI job spec is in [`docs/ci-live-db.md`](docs/ci-live-db.md).
