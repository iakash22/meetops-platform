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
- Fields: camelCase in Prisma, `@map("snake_case")` in columns, e.g. `organizationId` maps to `organization_id`.
- Contract field names equal Prisma field names wherever the meaning is the same. Use `organizationId`,
  never `orgId`. Use `sizeBytes` and `mimeType` on FileObject.
- Timestamps are `createdAt` / `updatedAt` (`DateTime @db.Timestamptz`). Contracts serialize them as ISO-8601 strings.
- IDs are opaque strings (cuid/uuid). Every tenant-scoped model has `organizationId`.

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
