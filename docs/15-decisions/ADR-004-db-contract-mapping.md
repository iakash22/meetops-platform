# ADR-004: Mapping the database (Prisma) to `@meetops/contracts`

- Status: Proposed
- Date: 2026-10-21
- Owner: Architecture Agent (ARCH), with the Database Agent (DB) and the Backend Agent (BE)
- Related: [ADR-003 Contracts ownership](./ADR-003-contracts-ownership.md), ADR-001 Modular monolith

## Context

`@meetops/contracts` (TypeBox + `Static` types) is the public shape of every entity crossing a process or
package boundary: HTTP, queues, web, extension. `packages/database` (Prisma) is the storage shape. The first
schema draft (PR #6) drifted from the contracts in several places:

- `InternalTask` vs `Task`
- `ExternalIssueLink` vs `IntegrationIssue`
- no `Recording` model
- UPPERCASE enum values vs lowercase contract literals
- `@prisma/client` re-exported to all consumers

## Decision

### 1. Model names match contract names

Each contract entity has a Prisma model with the same PascalCase name: `Organization`, `User`, `Membership`,
`Project`, `Meeting`, `Recording`, `FileObject`, `Transcript`, `TranscriptSegment`, `Report`, `Task`,
`ExtractedTask`, `IntegrationIssue`.

- `InternalTask` is renamed to `Task`, and `ExternalIssueLink` to `IntegrationIssue`.
- `Recording` is added and points at a `FileObject` (`recording.fileObjectId`).
- Storage-only models (Session, Invitation, AuditLog, OutboxEvent, AiRun, TaskApproval, ...) may exist
  without a contract until they are exposed.

### 2. Enum values are lowercase in the database and in contracts

Prisma enum members stay valid identifiers, and each one is mapped to the lowercase contract literal.
Enum type names in the DB are snake_case:

```prisma
enum MembershipRole {
  OWNER  @map("owner")
  ADMIN  @map("admin")
  MEMBER @map("member")
  VIEWER @map("viewer")
  @@map("membership_role")
}
```

Mappers convert in both directions, for example `OWNER` → `'owner'`. Enum value sets must equal the contract
unions. Adding a value is a contracts change, handled under ADR-003.

### 3. Naming conventions

- Models: PascalCase singular, with `@@map("snake_case_plural")`, e.g. `Task` maps to `tasks`.
- Fields: camelCase in Prisma, `@map("snake_case")` in columns (see 3a; `organizationId` maps to `org_id`).
- Contract field names equal Prisma field names wherever the meaning is the same. Use `organizationId`,
  never `orgId`. Use `sizeBytes` and `mimeType` on FileObject.
- Timestamps are `createdAt` / `updatedAt` (`DateTime @db.Timestamptz`). Contracts serialize them as ISO-8601 strings.
- IDs are opaque strings (cuid/uuid). Every tenant-scoped model has `organizationId`.

### 3a. Column mapping for camelCase fields (`organizationId` → `org_id`)

Prisma and contract field names stay camelCase and identical, e.g. `organizationId`. Only the physical
column name differs, set explicitly with `@map`. The tenant key uses the short column name `org_id`:

```prisma
model Task {
  id             String   @id @default(cuid())
  organizationId String   @map("org_id")
  meetingId      String?  @map("meeting_id")
  assigneeId     String?  @map("assignee_id")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime @updatedAt      @map("updated_at") @db.Timestamptz
  organization   Organization @relation(fields: [organizationId], references: [id])
  @@index([organizationId, createdAt])
  @@map("tasks")
}
```

Rules:

- Every multi-word field gets an explicit `@map("snake_case")`. Do not rely on the default column naming.
- Foreign keys use `<entity>_id` (`meeting_id`, `file_object_id`, `user_id`). The single exception is
  `organizationId` → `org_id`, applied the same way on every tenant-scoped table.
- Relation fields (`organization`, `meeting`) are not columns and have no `@map`.
- Indexes and constraints reference Prisma field names. Name them with `map:` when the SQL name matters,
  e.g. `@@index([organizationId], map: "tasks_org_id_idx")`.
- `orgId` must not appear in Prisma fields, contracts, DTOs or API params. Use `:organizationId` in routes.
- Mappers never rename fields. If a column needs a different name, change `@map`, not the DTO.

### 4. DTO mappers live in `apps/api/src/mappers`

- One file per aggregate, e.g. `mappers/task.ts` exporting `toTaskDto(row): Task` and, where needed,
  `fromCreateTaskInput(...)`.
- Mappers convert `Date` to an ISO string and enums to lowercase literals. They drop storage-only columns such as
  password hashes, soft-delete flags and internal ids. They also map provider-level storage metadata
  (`size`/`contentType`) to `FileObject.sizeBytes`/`mimeType`.
- Each mapper has a unit test that runs `Value.Check(<ContractSchema>, toXDto(fixtureRow))`.
- `apps/worker` may keep its own mappers in `apps/worker/src/mappers` for job payloads. Logic shared by both
  goes in `apps/api` only after it is extracted to a dedicated internal package, approved by ARCH.

### 5. Prisma types never leave apps/api and apps/worker

- Only `apps/api` and `apps/worker` may depend on `@meetops/database`.
- `packages/*` (except database itself), `apps/web`, `apps/extension`, `apps/desktop` and `tests/` (except DB
  integration tests) must not import `@prisma/client` or `@meetops/database`.
- `@meetops/database` should stop `export * from '@prisma/client'` broadly. It should export the client factory
  and the types that api/worker need.
- Enforcement: an ESLint `no-restricted-imports` rule (OPS) plus a CODEOWNERS entry for packages/contracts (ARCH).
- Responses, queue payloads and events are always typed as contract types, never Prisma types.

### 6. Ownership and change process

- DB owns `packages/database`, BE owns `apps/api/src/mappers`, and ARCH owns the contracts and this ADR.
- A schema change that alters an exposed field, enum or model name needs one of two things. Either a matching
  contracts PR labelled `contracts`, reviewed by ARCH under ADR-003, or an explicit decision that the change is
  internal-only (the mapper absorbs it).
- Order of merging: contracts, then the DB migration, then mappers and consumers. Mapper tests must pass in CI
  before a migration merges.
- Renames ship as migrations with `@map` preserved, or as explicit `ALTER ... RENAME`, never drop and recreate,
  so data is retained.

## Consequences

- There is one public shape and one storage shape, with a single conversion point.
- The mapper layer is extra code, but it is small and well tested, and it isolates Prisma upgrades.
- PR #6 needs follow-up changes: the renames, the Recording model, `@map` on enums and columns, and a narrowed
  database exports list.

## Addendum (2026-10-21): decisions on the DB PR #25 mismatches

These were decided by ARCH and applied in `@meetops/contracts` 0.2.0. DB must match them.

| #   | Decision                                                                           | Contracts                                                                                                                                                                            | DB action                                                                                                |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| a   | The link direction follows the DB: a Task points at the ExtractedTask it came from | `Task.extractedTaskId?`; `ExtractedTask.acceptedTaskId` removed                                                                                                                      | keep `tasks.extracted_task_id` (FK, unique)                                                              |
| b   | Extracted tasks reference transcript segments by id                                | `ExtractedTask.sourceSegmentIds: uuid[]` (was `sourceSegmentIndexes`)                                                                                                                | `source_segment_ids uuid[]`, or a join table                                                             |
| c   | Report content is structured and stored as JSON                                    | `Report` exposes `summary`, `decisions`, `risks`, `actionItems`; the exported `ReportContent` schema validates `reports.content`; `modelRouteId` is replaced by `aiRunId` (nullable) | `content jsonb`, validated with `ReportContent` on write and read; `ai_run_id uuid null` FK to `ai_runs` |
| d   | Transcripts record their STT provider                                              | `Transcript.provider: SttProviderId`, `providerJobId?`                                                                                                                               | **add columns** `provider` (enum: assemblyai, faster-whisper, deepgram) and `provider_job_id text null`  |
| e   | Meetings can be created without a user (bot or import sources)                     | `Meeting.createdById: uuid \| null`                                                                                                                                                  | `created_by_id` nullable                                                                                 |
| f   | Meeting participants are part of the contracts                                     | `MeetingParticipant { id, meetingId, organizationId, userId \| null, displayName, email? \| null, role: host \| participant, joinedAt?, leftAt? }`                                   | map the enum to `host`/`participant` (rename `ATTENDEE`/`GUEST` → `participant`); add `org_id`           |
| g   | **All ids are UUIDs**                                                              | `Id` is `format: uuid` everywhere                                                                                                                                                    | `@id @default(uuid()) @db.Uuid` (or `dbgenerated("gen_random_uuid()")`); every FK is `@db.Uuid`; no cuid |

`Session` stays internal to DB and API. It is not a contract, and clients only see `AuthSession` / `GetAuthSessionResponse`.
`TranscriptSegment` now carries an `id`, which (b) needs.

## Addendum 2 (2026-10-22): DB mismatch decisions (contracts 0.3.0)

| #   | Decision                                              | Contracts                                                   | DB action                                                                                                             |
| --- | ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| a   | `organizationId` is canonical                         | unchanged: always `organizationId`                          | the Prisma field is `organizationId @map("org_id")`. The DB package must not expose `orgId` in types, queries or DTOs |
| b   | `ExtractedTask.reportId` is required                  | already required                                            | `extracted_tasks.report_id` **NOT NULL** (FK to `reports`)                                                            |
| c   | `Transcript.provider` is required                     | already required (`SttProviderId`)                          | `transcripts.provider` **NOT NULL**                                                                                   |
| d   | `participants.employee_id` is HR PII and out of scope | not in contracts (`MeetingParticipant` has no `employeeId`) | **drop** `employee_id` from `meeting_participants` unless a spec explicitly requires it (it would need SEC review)    |
| e   | The only link is from Task to ExtractedTask           | `Task.extractedTaskId`; no `acceptedTaskId` anywhere        | `tasks.extracted_task_id` (FK, unique) only, with no reverse column                                                   |

These are guarded by `packages/contracts/test/v030.test.ts`.
