# Multi-tenant isolation

Tenant = organization. Names follow ADR-010: SQL column `org_id`, Prisma field `organizationId @map("org_id")`, RLS setting `app.current_organization_id`, context helper `runWithOrganizationContext`, object keys `organizations/{organizationId}/…`. Defense in depth: (1) schema, (2) repository layer, (3) Postgres RLS, (4) tests.

## 1. Schema rules

- Every tenant-owned table has `org_id uuid NOT NULL REFERENCES organizations(id)`, including child tables (e.g. meeting_participants, transcript_segments, file_objects, tasks, transcript_chunks, audit_events, recording_sessions, recording_session_chunks; `TENANT_TABLES` in `packages/database/src/tenant.ts` is the list). Teams add `teams` and `team_members` (DB-1). Do not rely on joins to inherit tenancy.
- Composite indexes lead with `org_id` (e.g. `(org_id, created_at)`); unique constraints are per-org (`UNIQUE (org_id, external_id)`).
- Cross-table FKs within a tenant should be composite `(org_id, id)` where practical so a row can't reference another org's parent. `team_members` uses composite FKs `(org_id, team_id) → teams` and `(org_id, employee_id) → employees`; `projects.team_id`, if added, uses `(org_id, team_id)`.
- Object storage keys are prefixed `organizations/{organizationId}/…` (session chunks: `tmp/session-chunks/organizations/{organizationId}/…`), built only by `@meetops/storage` (`organizationPrefix`, `buildObjectKey`). Legacy `org/{organizationId}/…` keys are readable during ADR-010 phase A only and rejected in phase B; writers never produce them. Consumers resolve keys from `file_objects.storage_key` and never rebuild paths; ownership is checked with `assertKeyOwnedBy(key, organizationId, meetingId?)`.
- Queue job payloads carry `organizationId` + ids only.
- Global tables (users, organizations, plans) are explicitly listed and reviewed; membership lives in `memberships(org_id, user_id, role)`.
- `file_objects` has `org_id` (`FileObject.organizationId`) and is RLS-forced like every other tenant table.

## 2. Repository layer

- All data access goes through repositories that take a tenant context `{ organizationId, userId, role }` from the authenticated session; never take `organizationId` from the request body/query (the `:organizationId` path segment must equal the session's active organization, else 404).
- Every query runs inside `runWithOrganizationContext(client, organizationId, fn)` and includes `where: { organizationId }`; `findUnique` by id alone is forbidden for tenant tables (use `findFirst({ where: { id, organizationId } })`). The deprecated `runWithOrgContext` alias is removed one minor after ADR-010.
- A lint rule / code review check flags raw `prisma.<tenantModel>` usage outside repositories. Raw SQL (`$queryRaw`) must include `org_id` predicates and be reviewed.
- Workers rebuild the context from the job's `organizationId`, then verify the loaded record's `organizationId` and the key prefix (`assertKeyOwnedBy`) match it.
- pgvector similarity search must filter `WHERE org_id = $1` before ordering.

## 3. Postgres RLS plan

- App connects as role `meetops_app` (NOT owner, NOT `BYPASSRLS`). Migrations run as `meetops_migrator`.
- For every tenant table:

```sql
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks
  USING (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
```

- Unset setting → `NULL` → no rows (fail closed). `NULLIF(…, '')` matters: after a LOCAL setting ends, a pooled connection reads `''`, not `NULL`.
- Existing policies COALESCE the legacy `app.current_org_id` for one minor version (ADR-010); new migrations (e.g. `teams`, `team_members`) use `app.current_organization_id` only, with no new COALESCE.
- Set per transaction, never per session (pooled connections leak session state). `runWithOrganizationContext` does this:

```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`; // true = LOCAL
  return fn(tx);
});
```

- With PgBouncer use transaction pooling; `SET LOCAL`/`set_config(...,true)` is safe there.
- Cross-org system jobs (billing, retention) use a separate role with audited `BYPASSRLS`, never the request path.
- Rollout: enable RLS in migrations alongside table creation; CI check asserts every table with `org_id` has RLS enabled + forced.

## 4. Test requirements

- Fixture: two orgs (A, B) with users of each role and data in every tenant table.
- For every API route: user of org A requesting org B's resource ids gets `404` (not 403, to avoid existence leak); list endpoints never return B rows.
- Repository tests: calls with org A context cannot read/update/delete B rows.
- RLS tests run as `meetops_app`: without `app.current_organization_id` → 0 rows; with A → only A; INSERT with B's org_id under A context fails `WITH CHECK`.
- Connection-reuse test: after an A transaction, next transaction on same connection without setting sees 0 rows.
- Worker tests: job whose `organizationId` does not match the record or key prefix fails closed.
- Teams (DB-1): org A cannot read, insert or update B's `teams`/`team_members`, and a `team_members` row pointing at another org's team or employee fails the composite FK (XT-40).
- Search/embedding tests: semantic search never returns other-org chunks.
- Catalog test: query `pg_class`/`pg_policies` to assert coverage for all `org_id` tables.
