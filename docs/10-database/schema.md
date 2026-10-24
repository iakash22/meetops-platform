# Database schema (Phase 1, P1-DB)

> **Source:** this page reflects the merged code on `integration/phase-1` (`packages/database`), after PR #35 merged on 2026-10-22. The schema from PR #6 and the RLS work from PR #25 reached `integration/phase-1` through stacked PR #35. PRs #6 and #25 were closed as superseded on 2026-10-22; their work landed via #35.

Package: `packages/database` (`@meetops/database`). PostgreSQL with Prisma and pgvector. Env: `DATABASE_URL`.

## Conventions

- Tables are snake_case via `@@map`, columns snake_case via `@map`.
- `uuid` ids, `timestamptz` timestamps.
- Every tenant-scoped table has `org_id` (FK → `organizations`, cascade delete), and its indexes lead with `org_id`.
- Soft delete (`deleted_at`) on organizations, users, memberships, employees, projects, meetings, file_objects, transcripts, reports, extracted_tasks and internal_tasks.

## Models (25 in `schema.prisma`)

| Area                | Models (table)                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy and auth    | Organization (`organizations`), User (`users`), Membership (`memberships`), Session (`sessions`), Invitation (`invitations`), EmailVerification (`email_verifications`), PasswordReset (`password_resets`)                                |
| People and work     | Employee (`employees`), Project (`projects`)                                                                                                                                                                                              |
| Meetings and media  | Meeting (`meetings`), MeetingParticipant (`meeting_participants`), FileObject (`file_objects`: kind, status, provider, bucket, key, mime type, size, checksum; optional parent object and `chunkIndex`; unique per org + bucket + key)    |
| Recordings          | Recording (`recordings`: one FileObject, status, duration), RecordingSession (`recording_sessions`: source, status, abort reason, chunk count, total bytes), RecordingSessionChunk (`recording_session_chunks`: unique `seq` per session) |
| Transcripts         | Transcript (`transcripts`: tied to a recording; provider + `providerJobId`, unique per org; revision unique per meeting), TranscriptSegment (`transcript_segments`: revision + sequence, `embedding vector(1536)`)                        |
| AI output and tasks | Report (`reports`), ExtractedTask (`extracted_tasks`), TaskApproval (`task_approvals`), Task (`tasks`), IntegrationIssue (`integration_issues`: provider, external id and URL, unique per org)                                            |
| Ops and audit       | AiRun (`ai_runs`), OutboxEvent (`outbox_events`), AuditEvent (`audit_events`: nullable org for global events, actor, action, target, metadata; append-only)                                                                               |

Enums (21): MembershipRole (`owner`, `admin`, `member`, `viewer`), InvitationStatus, ProjectStatus, MeetingStatus, MeetingParticipantRole, TranscriptStatus, ReportStatus, ExtractedTaskStatus, TaskPriority, ApprovalDecision, TaskStatus, AiRunStatus, AiRunKind, StorageObjectKind, StorageObjectStatus, OutboxStatus, MeetingSource, RecordingStatus, RecordingSource, RecordingSessionStatus, RecordingAbortReason.

## Tenancy and RLS

- Every tenant-scoped table has `org_id`, and its indexes lead with `org_id`.
- **Forced RLS** (`20261021110000_tenant_rls_roles`, authored in PR #25): every table in `TENANT_TABLES` (`src/tenant.ts`, 20 tables) has RLS enabled and **forced**, keyed on `org_id`. Policies read the transaction-local setting `app.current_org_id`. `organizations`, `users` and `sessions` are global tables.
  - `20261021130000_rls_fail_closed_empty_setting` recreates the policies with `NULLIF(current_setting(...), '')::uuid`, so an unset or reset setting returns no rows instead of an error.
  - `20261022034000_assert_forced_rls` makes the migration fail if any table has RLS enabled but not forced.
- **Roles:**
  - `meetops_migrator` owns the schema and runs migrations (`MIGRATION_DATABASE_URL`).
  - `meetops_app` is the runtime role (`DATABASE_URL`). It gets DML only, and the migration asserts that it is `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`.
  - `meetops_relay` (optional): `NOBYPASSRLS`, no table privileges; only executes `relay_claim_outbox_events` / `relay_complete_outbox_event` (`SECURITY DEFINER`, `20261022033000_relay_definer_functions`).
  - Roles and passwords are provisioned out of band (`scripts/bootstrap-roles.sql`, `pnpm --filter @meetops/database db:roles`). Migrations never contain passwords.
- **Application access:** `withOrgContext(organizationId, fn, { client?, userId?, timeoutMs? })` runs `fn` in one interactive transaction with `app.current_org_id` set `LOCAL`. That setting is safe with pooled connections. `withUserContext(userId, fn)` sets only `app.current_user_id`, so a user can list their own memberships (`membership_self_read`) while every other tenant table stays fail-closed. Both validate UUIDs. The lower-level `runWithOrgContext` and `runWithUserContext` live in `src/tenant.ts`.
- **Audit:** `audit_events` is append-only, including for the owner (`20261022032000_audit_append_only`). The only exception is a maintenance migration that sets `meetops.audit_maintenance = on` while logged in as `meetops_migrator`. `20261022041000_audit_hatch_session_user` checks `session_user`, not `current_user`, so a migrator-owned `SECURITY DEFINER` function can't open the hatch for another caller.
- **Invitations:** `lookup_invitation_by_token_hash` and `accept_invitation` are `SECURITY DEFINER` functions, executable only by `meetops_app`. The PR #35 fix is described below.
- **API-side guard:** Backend PR #53 (`feat/api-persistence`, merged 2026-10-24) adds the API-side refusal to invite users who are already active members. The database-side `already_member` guard is merged and described below.

## pgvector

`previewFeatures = ["postgresqlExtensions"]` and `extensions = [vector]` in the datasource. The migration runs `CREATE EXTENSION IF NOT EXISTS "vector"`.

## Migrations

- Initial migration: `prisma/migrations/20261021000000_init_core_schema/migration.sql`, generated with `prisma migrate diff --from-empty --to-schema-datamodel --script`.
- There are 20 migrations (`20261021000000_init_core_schema` through `20261022041000_audit_hatch_session_user`). PR #35 verified them against a live Postgres (`pgvector/pgvector:pg16`): `prisma migrate deploy` from empty, then a drift check.

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

Everything from `@prisma/client`, plus `createPrismaClient`, `getPrismaClient` (global singleton), `disconnectPrismaClient`, `withOrgContext`, `withUserContext`, and the `DatabaseClient`, `DatabaseTransaction` and `OrgContextOptions` types.

## Invitation acceptance: no owner demotion (PR #35, merged)

Merged into `integration/phase-1` by PR #35 (merge commit `f7c2d77`), migration `20261022040000_accept_invitation_active_member` (architecture review item B1). It replaces `accept_invitation(text, uuid)`.

- Problem fixed: the earlier version (`20261022030000_accept_invitation_role`) rewrote the role of any existing membership, so a sole owner who accepted a viewer invite left the org with no owner.
- Now, for the invitee's membership in the invitation's org:
  - **Active** (`deleted_at IS NULL`): the call raises `already_member` (SQLSTATE `P0001`) and nothing changes. An invitation never changes an active membership's role.
  - **Soft-deleted**: revived with the invitation's role.
  - **None**: inserted with the invitation's role (unchanged).
- A race where a concurrent accept makes the membership active first also raises `already_member`.
- On `already_member` the whole call aborts, so the invitation stays `pending`, is not consumed, and no audit row is written. An admin can see and revoke it, or it expires. The migration comment says the API should also refuse to invite active members.
- Other checks are unchanged: pending status, not revoked, not expired, and the user's email matches (case-insensitive). These failures still return `invitation_invalid` (`P0002`).
- On success it marks the invitation accepted and writes an `audit_events` row with action `invitation.accepted`.
- The function stays `SECURITY DEFINER` with `SET search_path = public, pg_temp`, owned by `meetops_migrator`; `EXECUTE` is revoked from PUBLIC and granted to `meetops_app` only.

PR #35 also adds the RLS, roles, outbox relay and live-test migrations; see `packages/database/README.md`.
