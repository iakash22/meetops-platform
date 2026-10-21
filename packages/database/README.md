# @meetops/database

Prisma schema, migrations, seed and tenant-safe client for MeetOps (PostgreSQL 16 + pgvector).

## Public API
`createPrismaClient`, `getPrismaClient`, `disconnectPrismaClient`, `withOrgContext(orgId, fn, { client?, userId?, timeoutMs? })`, plus the types `DatabaseClient`, `DatabaseTransaction` and `OrgContextOptions`. Every tenant query must run inside `withOrgContext`: forced RLS returns no rows without it.

## Roles and env
| Role | Purpose | Env |
| --- | --- | --- |
| `meetops_app` | runtime (NOBYPASSRLS, DML only) | `DATABASE_URL` |
| `meetops_migrator` | owns the schema; runs migrations | `MIGRATION_DATABASE_URL` (Prisma `directUrl`) |
| `meetops_relay` (optional) | outbox relay (BYPASSRLS; only SELECT plus delivery-column UPDATE on `outbox_events`) | relay service URL |

## Local setup

### 1. Start Postgres with pgvector
```bash
docker run -d --name meetops-db -e POSTGRES_PASSWORD=<admin-pw> -p 127.0.0.1:5432:5432 pgvector/pgvector:pg16
```
Or use `pnpm dev:infra:up` from the repo root.

### 2. Create the roles and database (idempotent; re-run to rotate passwords)
The scripts need these env vars. They fail if a required one is unset, and never print passwords.

| Var | Required |
| --- | --- |
| `ADMIN_DATABASE_URL` | yes: superuser connection to the `postgres` DB |
| `MEETOPS_APP_PASSWORD` | yes |
| `MEETOPS_MIGRATOR_PASSWORD` | yes |
| `MEETOPS_RELAY_PASSWORD` | no: when set, also creates `meetops_relay` |
| `MEETOPS_DB_NAME` | no: default `meetops` |

**Linux / macOS (bash/zsh):**
```bash
export ADMIN_DATABASE_URL='postgresql://postgres:<admin-pw>@localhost:5432/postgres'
read -rs MEETOPS_APP_PASSWORD && export MEETOPS_APP_PASSWORD
read -rs MEETOPS_MIGRATOR_PASSWORD && export MEETOPS_MIGRATOR_PASSWORD
pnpm --filter @meetops/database db:roles        # TypeScript, no psql required
# or, with psql installed:
pnpm --filter @meetops/database db:roles:sh     # scripts/create-db-roles.sh
```

**Windows (PowerShell):**
```powershell
$env:ADMIN_DATABASE_URL = 'postgresql://postgres:<admin-pw>@localhost:5432/postgres'
$env:MEETOPS_APP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'app password' -AsSecureString)))
$env:MEETOPS_MIGRATOR_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'migrator password' -AsSecureString)))
pnpm --filter @meetops/database db:roles
```

Variants:
- `scripts/create-db-roles.ts` works on any OS and sends passwords as bind parameters.
- `scripts/create-db-roles.sh` (POSIX sh + psql) feeds variables over stdin.
- `scripts/bootstrap-roles.sql` is the raw psql file both use; its header documents direct use.

### 3. Migrate, seed, test
Percent-encode special characters in passwords inside URLs.
```bash
export MIGRATION_DATABASE_URL="postgresql://meetops_migrator:<pw>@localhost:5432/meetops"
export DATABASE_URL="postgresql://meetops_app:<pw>@localhost:5432/meetops"
pnpm --filter @meetops/database db:migrate:deploy
pnpm --filter @meetops/database db:seed
RLS_TEST_APP_URL=$DATABASE_URL RLS_TEST_OWNER_URL=$MIGRATION_DATABASE_URL pnpm --filter @meetops/database test:live
```
In PowerShell, use `$env:NAME = '...'` for the same variables.

The CI job spec is in [`docs/ci-live-db.md`](docs/ci-live-db.md).
