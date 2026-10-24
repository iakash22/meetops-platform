# ADR-010: `organizationId` as the canonical tenant key

- Status: **Proposed - needs Architecture review**
- Date: 2026-10-24
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

The Architecture Agent made three binding decisions. This ADR records them:

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
3. **Storage object-key prefixes and path strings do not change.** Keys stay
   `org/{organizationId}/meetings/{meetingId}/...` and `tmp/session-chunks/org/{organizationId}/...`. Only
   the TypeScript identifiers change.

### Naming table

| Layer                      | Canonical                                   | Deprecated (one minor)   |
| -------------------------- | ------------------------------------------- | ------------------------ |
| SQL column / FK / indexes  | `org_id` (unchanged)                        | n/a                      |
| Prisma field               | `organizationId @map("org_id")`             | n/a (already done)       |
| Context helper             | `withOrganizationContext`                   | `withOrgContext`         |
| Low-level helper           | `runWithOrganizationContext`                | `runWithOrgContext`      |
| RLS session variable (GUC) | `app.current_organization_id`               | `app.current_org_id`     |
| Storage prefix helper      | `organizationPrefix(organizationId)`        | `orgPrefix(orgId)`       |
| Storage ownership check    | `assertKeyOwnedBy(key, organizationId, m?)` | positional name only     |
| Storage refs               | `MeetingObjectRef.organizationId`           | `MeetingObjectRef.orgId` |
| Object-key string          | `org/{organizationId}/...` (unchanged)      | n/a                      |

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

## Compatibility plan

- Deprecated wrappers are thin re-exports or delegating functions with `@deprecated` JSDoc, so editors and
  `eslint` (if `@typescript-eslint/no-deprecated` is enabled) flag callers. They are removed one minor
  version later.
- Callers in other packages (apps/api, apps/worker, tests/) keep compiling unchanged. Their owners migrate
  on their own schedule.
- Existing object keys stay readable because the key format does not change. `parseMeetingKey` and
  `assertKeyOwnedBy` accept exactly the same strings as before.

## Consequences

- No data migration and no object-store rewrite.
- For one minor version, the policies read two GUCs. After that, the `app.current_org_id` fallback is removed.
- `orgId` disappears from exported DB and storage identifiers once the aliases are removed. The column
  name `org_id` stays by design.
