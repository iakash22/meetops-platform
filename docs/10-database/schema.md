# Database schema (Phase 1, P1-DB)

> **Note:** This page describes **open PR #6** (`feat/database-core-schema`), which is not merged yet. Source: head commit `1fe9123060ede0bc2024a37d78f2db47610265c0`, read via `gh pr view 6` / `gh pr diff 6`. Update this page if the PR changes before merge.

Package: `packages/database` (`@meetops/database`). PostgreSQL with Prisma and pgvector. Env: `DATABASE_URL`.

## Conventions

- Tables are snake_case via `@@map`, columns snake_case via `@map`.
- `uuid` ids, `timestamptz` timestamps.
- Every tenant-scoped table has `org_id` (FK → `organizations`, cascade delete), and its indexes lead with `org_id`.
- Soft delete (`deleted_at`) on organizations, users, memberships, employees, projects, meetings, file_objects, transcripts, reports, extracted_tasks and internal_tasks.

## Models (19 in `schema.prisma`)

| Area                | Models (table)                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenancy and auth    | Organization (`organizations`), User (`users`), Membership (`memberships`), Session (`sessions`), Invitation (`invitations`)                                                                                       |
| People and work     | Employee (`employees`), Project (`projects`)                                                                                                                                                                       |
| Meetings            | Meeting (`meetings`), MeetingParticipant (`meeting_participants`), FileObject (`file_objects`: bucket, key, mime type, size, SHA-256 checksum; metadata only)                                                      |
| Transcripts         | Transcript (`transcripts`, revisioned, unique per meeting), TranscriptSegment (`transcript_segments`, revision + sequence, `embedding vector(1536)` placeholder)                                                   |
| AI output and tasks | Report (`reports`), ExtractedTask (`extracted_tasks`), TaskApproval (`task_approvals`), InternalTask (`internal_tasks`), ExternalIssueLink (`external_issue_links`: provider, external id and URL, unique per org) |
| Ops and audit       | AiRun (`ai_runs`: provider, model, prompt version, transcript revision, token usage, `cost_usd`, status), OutboxEvent (`outbox_events`), AuditLog (`audit_logs`)                                                   |

Enums: MembershipRole (OWNER, ADMIN, MEMBER, VIEWER), InvitationStatus, ProjectStatus, MeetingStatus, MeetingParticipantRole, TranscriptStatus, ReportStatus, ExtractedTaskStatus, TaskPriority, ApprovalDecision, InternalTaskStatus, ExternalProvider, AiRunStatus, AiRunKind, OutboxStatus.

## Tenancy and RLS

- Tenancy is enforced at the schema level by `org_id` on every tenant-scoped table, with org-leading indexes.
- **RLS:** PR #6 contains no row-level security policies (no `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` in the migration). Any RLS plan is outside this PR and not documented here yet; isolation currently relies on application-level `org_id` scoping.

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

PR #35 also adds the RLS, roles, outbox relay and live-test migrations; see `packages/database/README.md`. The note at the top of this page about PR #6 is older than these merges.
