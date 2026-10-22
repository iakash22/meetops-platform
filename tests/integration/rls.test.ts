import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { isDockerAvailable } from '../support/env.js';
import {
  applyDatamodelPlusRls,
  applyMigrations,
  dbPackageDir,
  hasRlsMigration,
} from '../support/db-package.js';

/*
 * Forced RLS checks XT-26..XT-29 (docs/12-security/test-cases.md) against the schema from
 * DB's PR #25 (feat/database-tenancy-rls). Point QA_DB_PACKAGE_DIR at a checkout of that
 * branch's packages/database. Skips without Docker or without an RLS migration.
 *
 * Writes go through a LOGIN role that inherits meetops_app (NOSUPERUSER, NOBYPASSRLS), the
 * same privileges the API will have. Setup data is inserted by the container superuser.
 */
const docker = isDockerAvailable();
const rls = hasRlsMigration();
if (docker && !rls)
  console.warn(
    `[integration/rls] no RLS migration under ${dbPackageDir}: skipping (set QA_DB_PACKAGE_DIR)`,
  );

// 'migrations' (default): prisma migrate deploy, exactly like production.
// 'datamodel': schema.prisma + RLS migration only; workaround while the chain is broken (DB-BUG-1).
const schemaMode = process.env.QA_RLS_SCHEMA === 'datamodel' ? 'datamodel' : 'migrations';

const APP_ROLE = 'qa_app_login';
const APP_PASSWORD = 'qa-only-not-a-secret';

describe.skipIf(!docker || !rls)(`integration: RLS (PR #25, schema via ${schemaMode})`, () => {
  let container: StartedPostgreSqlContainer;
  let owner: pg.Client;
  let app: pg.Client;
  let tenantTables: string[] = [];
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      process.env.QA_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16',
    ).start();
    owner = new pg.Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    // In 'migrations' mode a failure here is a product bug (see README "Known bugs").
    if (schemaMode === 'datamodel') await applyDatamodelPlusRls(owner);
    else await applyMigrations(container.getConnectionUri(), owner);

    await owner.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE meetops_app`,
    );
    const url = new URL(container.getConnectionUri());
    url.username = APP_ROLE;
    url.password = APP_PASSWORD;
    app = new pg.Client({ connectionString: url.toString() });
    await app.connect();

    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
        WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace
        ORDER BY 1`,
    );
    tenantTables = rows.map((r) => r.relname);

    for (const [id, slug] of [
      [orgA, 'rls-a'],
      [orgB, 'rls-b'],
    ] as const) {
      await owner.query(
        'INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())',
        [id, slug, slug],
      );
      await owner.query(
        "INSERT INTO projects (id, org_id, name, key, updated_at) VALUES (gen_random_uuid(), $1, 'P', 'P', now())",
        [id],
      );
    }
  }, 240_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await container?.stop();
  });

  it('app role is a non-superuser without BYPASSRLS', async () => {
    const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
      [[APP_ROLE, 'meetops_app']],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('[XT-26] without app.current_org_id every tenant table returns 0 rows', async () => {
    expect(tenantTables.length).toBeGreaterThan(0);
    const owned = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM projects');
    expect(owned.rows[0]?.n).toBeGreaterThanOrEqual(2);
    for (const t of tenantTables) {
      const { rows } = await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(rows[0]?.n, t).toBe(0);
    }
  });

  it('[XT-26] with context A only org A rows are visible', async () => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
      const { rows } = await app.query<{ org_id: string }>('SELECT org_id FROM projects');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.org_id === orgA)).toBe(true);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('[XT-27] context A cannot INSERT a row with org_id = B (WITH CHECK)', async () => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
      await expect(
        app.query(
          "INSERT INTO projects (id, org_id, name, key, updated_at) VALUES (gen_random_uuid(), $1, 'x', 'X', now())",
          [orgB],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM projects WHERE org_id = $1 AND key = 'X'",
      [orgB],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('[XT-27] context A cannot UPDATE an A row into org B', async () => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
      await expect(
        app.query('UPDATE projects SET org_id = $1 WHERE org_id = $2', [orgB, orgA]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
  });

  // DB-BUG-2: after a transaction-local set_config, Postgres leaves app.current_org_id = ''
  // (not NULL) for the rest of the session. Policies cast it with ::uuid, so the next query
  // without context on that pooled connection ERRORS (22P02) instead of returning 0 rows.
  // It still fails closed (no rows leak), checked below; the strict XT-28 expectation is
  // Fixed in PR #35 (NULLIF policies); this strict check fails against PR #25 head 30f542a.
  async function useContextThenCommit() {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
    const inside = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM projects');
    await app.query('COMMIT');
    expect(inside.rows[0]?.n).toBeGreaterThan(0);
  }

  it('[XT-28] no org A rows leak to the next transaction on the same connection (error or 0 rows)', async () => {
    await useContextThenCommit();
    const after = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM projects').then(
      (r) => r.rows[0]?.n ?? 0,
      (err: { code?: string }) => {
        expect(err.code).toBe('22P02');
        return 0;
      },
    );
    expect(after).toBe(0);
  });

  it('[XT-28] next transaction on the same connection returns 0 rows, not an error', async () => {
    await useContextThenCommit();
    const after = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM projects');
    expect(after.rows[0]?.n).toBe(0);
  });

  it('[XT-29] every table with org_id has RLS enabled + forced + at least one policy', async () => {
    const { rows } = await owner.query<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = current_schema() AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
        WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows
      .filter((r) => !(r.rls && r.forced && r.policies > 0))
      .map((r) => r.relname);
    expect(missing).toEqual([]);
  });
});
