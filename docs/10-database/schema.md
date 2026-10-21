# Database schema (Phase 1, P1-DB)

> **Note:** This page describes **open, unmerged PRs**: #6 (`feat/database-core-schema`, base `integration/phase-1`) at head `62c7b890c12eebfdf4598a7462c8fcdbbb3afa9d`, and #25 (`feat/database-tenancy-rls`, stacked on #6) at head `30f542a600d2250012f521937909e6584fe5b705`. Read via `gh pr view --json headRefOid` / `gh pr diff`. The sections before "Tenancy hardening and RLS (PR #25)" describe #6; #25 changes several of them, as noted there.

Package: `packages/database` (`@meetops/database`). PostgreSQL with Prisma and pgvector. Env: `DATABASE_URL`.

## Conventions

- Tables are snake_case via `@@map`, columns snake_case via `@map`.
- `uuid` ids, `timestamptz` timestamps.
- Every tenant-scoped table has `org_id` (FK → `organizations`, cascade delete), and its indexes lead with `org_id`.
- Soft delete (`deleted_at`) on organizations, users, memberships, employees, projects, meetings, file_objects, transcripts, reports, extracted_tasks and internal_tasks.

## Models in #6 (20 in `schema.prisma`)

| Area                | Models (table)                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenancy and auth    | Organization (`organizations`), User (`users`), Membership (`memberships`), Session (`sessions`), Invitation (`invitations`)                                                                                       |
| People and work     | Employee (`employees`), Project (`projects`)                                                                                                                                                                       |
| Meetings            | Meeting (`meetings`), MeetingParticipant (`meeting_participants`), FileObject (`file_objects`: bucket, key, mime type, size, SHA-256 checksum; metadata only)                                                      |
| Transcripts         | Transcript (`transcripts`, revisioned, unique per meeting), TranscriptSegment (`transcript_segments`, revision + sequence, `embedding vector(1536)` placeholder)                                                   |
| AI output and tasks | Report (`reports`), ExtractedTask (`extracted_tasks`), TaskApproval (`task_approvals`), InternalTask (`internal_tasks`), ExternalIssueLink (`external_issue_links`: provider, external id and URL, unique per org) |
| Ops and audit       | AiRun (`ai_runs`: provider, model, prompt version, transcript revision, token usage, `cost_usd`, status), OutboxEvent (`outbox_events`), AuditLog (`audit_logs`)                                                   |

Enums: MembershipRole (OWNER, ADMIN, MEMBER, VIEWER), InvitationStatus, ProjectStatus, MeetingStatus, MeetingParticipantRole, TranscriptStatus, ReportStatus, ExtractedTaskStatus, TaskPriority, ApprovalDecision, InternalTaskStatus, ExternalProvider, AiRunStatus, AiRunKind, OutboxStatus.

## Tenancy in #6

`org_id` on every tenant-scoped table, with org-leading indexes. #6 itself has no RLS; #25 adds it (below).

## pgvector

`previewFeatures = ["postgresqlExtensions"]` and `extensions = [vector]` in the datasource. The migration runs `CREATE EXTENSION IF NOT EXISTS "vector"`.

## Migrations

- Initial migration: `prisma/migrations/20261021000000_init_core_schema/migration.sql`, generated with `prisma migrate diff --from-empty --to-schema-datamodel --script`.
- Per the PR, it has **not been applied to a live database** yet.

## Scripts (`packages/database/package.json`)

| Script                            | Command                                      |
| --------------------------------- | -------------------------------------------- |
| `postinstall` / `prisma:generate` | `prisma generate`                            |
| `prisma:validate`                 | `prisma validate`                            |
| `db:migrate:dev`                  | `prisma migrate dev`                         |
| `db:migrate:deploy`               | `prisma migrate deploy`                      |
| `db:seed`                         | `prisma db seed` (runs `tsx prisma/seed.ts`) |

Run from the repo root with infra up (`pnpm dev:infra:up`):

```bash
pnpm --filter @meetops/database db:migrate:dev
pnpm --filter @meetops/database db:seed
```

The seed is idempotent: it creates a demo org, owner and member users with memberships and employees, a project, a recording file, a meeting with participants, and a transcript with segments.

## Exports (`src/index.ts`)

Everything from `@prisma/client`, plus `createPrismaClient`, `getPrismaClient` (global singleton), `disconnectPrismaClient` and the `DatabaseClient` type.

## Tenancy hardening and RLS (PR #25)

**(requires PR #25, unmerged; stacked on #6)**

### Migrations

- `20261021100000_tenancy_hardening`: generated with `prisma migrate diff` from #6's schema. Renames are drop and create, and enums are recast. Per the PR, this is only safe because no data is deployed.
- `20261021110000_tenant_rls_roles`: hand-written and idempotent.

### Roles

| Role               | Attributes                                                                                                                                                                  | Used via                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `meetops_app`      | NOLOGIN by default, NOSUPERUSER, NOBYPASSRLS, not owner; DML grants plus default privileges; `UPDATE`/`DELETE` revoked on `audit_events`; no access to `_prisma_migrations` | `DATABASE_URL` (runtime)                                                 |
| `meetops_migrator` | Owns schema objects (best-effort `ALTER TABLE … OWNER`)                                                                                                                     | `MIGRATION_DATABASE_URL` (Prisma `directUrl`): `migrate deploy` and seed |

Passwords and LOGIN are set out of band, never in SQL. Both URLs are required for `prisma validate` and `migrate`; `prisma generate` needs neither. For local steps see [Windows setup](../00-getting-started/windows-setup.md#6-database-migrations-with-two-roles).

### Row-level security

- `ENABLE` + `FORCE ROW LEVEL SECURITY` with policy `tenant_isolation`: `USING`/`WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid)` on 18 org tables.
- With no context set, the setting is NULL and no rows are returned (fails closed).
- A read-only `membership_self_read` policy (`user_id = app.current_user_id`) lets login and the org switcher list a user's own memberships.
- Global (non-RLS) tables: `organizations`, `users`, `sessions`.
- `withOrgContext(orgId, fn, { client?, userId?, timeoutMs? })` runs `fn` in one interactive transaction with a transaction-local `set_config('app.current_org_id', …)`. Non-UUID ids are rejected before the transaction opens.

### Schema changes on top of #6

- 21 models. New: `Recording`. Renamed: `InternalTask` → `Task` (`tasks`), `ExternalIssueLink` → `IntegrationIssue` (`integration_issues`), `AuditLog` → `AuditEvent` (`audit_events`).
- All enum labels are lowercase (for example MembershipRole `owner|admin|member|viewer`). New enums: `MeetingSource`, `RecordingStatus`, `StorageObjectKind`, `StorageObjectStatus`, `TaskStatus`.
- `UNIQUE(org_id, id)` on every tenant table. Tenant-to-tenant relations are composite FKs `(org_id, parent_id)`, and optional parents use `ON DELETE RESTRICT`.
- Per-org uniques: `file_objects(org_id, bucket, storage_key)`, `integration_issues(org_id, integration, external_id)`, `projects(org_id, key)`, `employees(org_id, email)`.
- `file_objects` gains media columns (kind raw/normalized/chunk, status, storage_key, etag, duration, format, sample rate, channels, chunk index/start, upload id, `parent_object_id`).
- Sessions store only `token_hash`, plus `last_seen_at`, `absolute_expires_at`, `auth_level`, `active_org_id`.
- Public API narrows to `createPrismaClient`, `getPrismaClient`, `disconnectPrismaClient`, `withOrgContext` and the types `DatabaseClient`, `DatabaseTransaction`, `OrgContextOptions`. Domain types come from `@meetops/contracts`, and `@prisma/client` is no longer re-exported.
- Scripts are unchanged (`db:migrate:dev`, `db:migrate:deploy`, `db:seed`); `build` uses `tsconfig.build.json`.
- Live RLS tests (`test/rls.live.test.ts`) are skipped unless `RLS_TEST_APP_URL` and `RLS_TEST_OWNER_URL` are set.
