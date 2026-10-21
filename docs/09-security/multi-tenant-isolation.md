# Multi-tenant isolation

Tenant = organization (`org_id`). Defense in depth: (1) schema, (2) repository layer, (3) Postgres RLS, (4) tests.

## 1. Schema rules
- Every tenant-owned table has `org_id uuid NOT NULL REFERENCES organizations(id)`, including child tables (meeting_segments, tasks, task_evidence, embeddings, files, audit_events, integration_connections, provider_configs). Do not rely on joins to inherit tenancy.
- Composite indexes lead with `org_id` (e.g. `(org_id, created_at)`); unique constraints are per-org (`UNIQUE (org_id, external_id)`).
- Cross-table FKs within a tenant should be composite `(org_id, id)` where practical so a row can't reference another org's parent.
- Object storage keys are prefixed `org/{orgId}/…`; queue job payloads carry `orgId` + ids only.
- Global tables (users, organizations, plans) are explicitly listed and reviewed; membership lives in `org_memberships(org_id, user_id, role)`.
- Note: current Prisma `FileObject` has no `orgId` yet — Database agent must add it.

## 2. Repository layer
- All data access goes through repositories that take a `TenantContext { orgId, userId, role }` from the authenticated request; never take `orgId` from request body/query.
- Every query includes `where: { orgId }`; `findUnique` by id alone is forbidden for tenant tables (use `findFirst({ where: { id, orgId } })`).
- A lint rule / code review check flags raw `prisma.<tenantModel>` usage outside repositories. Raw SQL (`$queryRaw`) must include `org_id` predicates and be reviewed.
- Workers rebuild `TenantContext` from the job's `orgId`, then verify the loaded record's `org_id` equals it.
- pgvector similarity search must filter `WHERE org_id = $1` before ordering.

## 3. Postgres RLS plan
- App connects as role `meetops_app` (NOT owner, NOT `BYPASSRLS`). Migrations run as `meetops_migrator`.
- For every tenant table:
```sql
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
```
- Unset setting → `NULL` → no rows (fail closed).
- Set per transaction, never per session (pooled connections leak session state):
```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`; // true = LOCAL
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
- RLS tests run as `meetops_app`: without `app.current_org_id` → 0 rows; with A → only A; INSERT with B's org_id under A context fails `WITH CHECK`.
- Connection-reuse test: after an A transaction, next transaction on same connection without setting sees 0 rows.
- Worker tests: job with mismatched orgId/object fails closed.
- Search/embedding tests: semantic search never returns other-org chunks.
- Catalog test: query `pg_class`/`pg_policies` to assert coverage for all `org_id` tables.
