# ADR-010: `organizationId` as the canonical tenant key

- Status: **Proposed - needs Architecture review**
- Date: 2026-10-24 (storage key format change decided 2026-10-24)
- Owners: Database Agent (DB) and Architecture Agent (ARCH), co-owners
- Related: [ADR-004 DB to contracts mapping](./ADR-004-db-contract-mapping.md) (section 3a), ADR-002 provider interfaces (storage)

## Context

ADR-004 already made `organizationId` the Prisma and contract field name, mapped to the `org_id` column.
The name `orgId` still appears in the database and storage runtime APIs:

- `@meetops/database`: `withOrgContext`, `runWithOrgContext`, `OrgContextOptions` and the RLS session
  variable (GUC) `app.current_org_id`.
- `@meetops/storage`: `orgPrefix(orgId)`, `assertKeyOwnedBy(key, orgId, ...)`, `MeetingObjectRef.orgId`,
  `SessionRef.orgId` and `parseMeetingKey(...).orgId`.

The Architecture Agent is doing the same naming cleanup in other packages (e.g. PR #75 for ai-core). This
ADR fixes one set of names so both agents converge.

## Decision

The Architecture Agent made three binding decisions, and decision 3 was revised on 2026-10-24. This ADR records them:

1. **TypeScript identifiers and exported APIs use `organizationId` everywhere.**
   - `withOrgContext` becomes `withOrganizationContext`, and `runWithOrgContext` becomes
     `runWithOrganizationContext`. `OrgContextOptions` becomes `OrganizationContextOptions`.
   - `orgPrefix(orgId)` becomes `organizationPrefix(organizationId)`, and the signature is
     `assertKeyOwnedBy(key, organizationId, meetingId?)`.
   - `MeetingObjectRef.orgId` becomes `MeetingObjectRef.organizationId`. The same rename applies to
     `SessionRef` and the result of `parseMeetingKey`.
   - The old names stay as `@deprecated` aliases for **one minor version**. After that they are removed.
2. **The SQL column stays `org_id`.** The Prisma model field is `organizationId @map("org_id")` on every
   tenant table (already true on `integration/phase-1` at 8da9449; ADR-004 §3a). No column, FK or index
   is renamed, so no table rewrite or lock-heavy migration is needed.
3. **Storage object-key prefix changes deliberately (decided 2026-10-24).** This supersedes the
   earlier draft, which said "prefixes unchanged". Keys move from `org/{organizationId}/...` to
   `organizations/{organizationId}/...`, and from `tmp/session-chunks/org/...` to
   `tmp/session-chunks/organizations/...`. The move happens in two phases (see "Storage key migration").

### Naming table

| Layer                      | Canonical                                         | Deprecated (one minor)                            |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| SQL column / FK / indexes  | `org_id` (unchanged)                              | n/a                                               |
| Prisma field               | `organizationId @map("org_id")`                   | n/a (already done)                                |
| Context helper             | `withOrganizationContext`                         | `withOrgContext`                                  |
| Low-level helper           | `runWithOrganizationContext`                      | `runWithOrgContext`                               |
| RLS session variable (GUC) | `app.current_organization_id`                     | `app.current_org_id`                              |
| Storage prefix helper      | `organizationPrefix(organizationId)`              | `orgPrefix(orgId)`                                |
| Storage ownership check    | `assertKeyOwnedBy(key, organizationId, m?)`       | positional name only                              |
| Storage refs               | `MeetingObjectRef.organizationId`                 | `MeetingObjectRef.orgId`                          |
| Object-key string          | `organizations/{organizationId}/...` (2026-10-24) | `org/{organizationId}/...` (read-only in Phase A) |

### RLS session variable

The GUC is not a column, so it follows the TypeScript naming: the canonical name is
`app.current_organization_id`. During the compatibility phase:

- A new migration recreates every tenant policy to read
  `COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid`.
  It stays fail-closed: when neither variable is set, the value is NULL and no rows match.
- `runWithOrganizationContext` sets both variables, transaction-local (`set_config(..., true)`), to the same
  value. Code from before or after the migration therefore works with a database from before or after it,
  so the deploy order does not matter.
- Removal (next minor): stop setting `app.current_org_id`, then a migration drops it from the policies.

## Storage key migration (decided 2026-10-24, co-signed by the Architecture Agent)

**Phase A (now).**

- New writes use `organizations/{organizationId}/`. Readers accept both prefixes.
- Ownership checks (`assertKeyOwnedBy` and the DB CHECK on `recording_session_chunks.storage_key`) verify that the
  organization segment equals the caller's `organizationId` under **either** prefix (DB side: PR #100).
- Consumers resolve object keys from `file_objects.key` (column `storage_key`) and **never rebuild paths** from ids.
  That way a row is the single source of truth while two formats coexist.
- Environments:
  - **dev** is wiped and reseeded (the seed writes `organizations/` keys).
  - **staging** gets a copy-backfill (`packages/database/scripts/backfill-organization-keys.ts`). The backfill:
    - copies each object to the new key with S3 CopyObject and **never moves or deletes** the old object;
    - verifies that each target exists with the same size and checksum;
    - updates `file_objects.key` in **one transaction per organization**, and rolls back that organization on any
      mismatch;
    - is idempotent (rows already migrated and matching copies are skipped);
    - runs as a dry run by default (`--apply` to write);
    - is verified by per-organization counts plus checksums.

**Phase B (later, a separate PR).**

- Readers and the DB CHECK reject `org/`, and the old objects are deleted.
- It is made only after the staging backfill is verified (counts and checksums match, with no `org/` rows left).
  The date of that verification is recorded here when Phase B lands.

## Compatibility plan

- Deprecated wrappers are thin re-exports or delegating functions with `@deprecated` JSDoc, so editors and
  `eslint` (if `@typescript-eslint/no-deprecated` is enabled) flag callers. They are removed one minor
  version later.
- Callers in other packages (apps/api, apps/worker, tests/) keep compiling unchanged. Their owners migrate
  on their own schedule.
- Existing `org/` object keys stay readable throughout Phase A (both prefixes accepted), and are copied, not
  moved, by the backfill. Old objects are deleted only in Phase B.

## Consequences

- No column rename and no table rewrite. Object keys need a copy-backfill per environment (staging), with old
  objects kept until Phase B.
- For one minor version, the policies read two GUCs. After that, the `app.current_org_id` fallback is removed.
- `orgId` disappears from exported DB and storage identifiers once the aliases are removed. The column
  name `org_id` stays by design.
