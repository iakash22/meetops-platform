/**
 * Live RLS checks XT-26..XT-29 (docs/12-security/test-cases.md).
 * Skipped unless RLS_TEST_APP_URL (connects as meetops_app) and RLS_TEST_OWNER_URL are set
 * against a migrated pgvector Postgres.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TENANT_TABLES, runWithOrgContext } from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('RLS live (XT-26..XT-29)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();

  it('setup two orgs with a project each', async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'A', slug: `a-${orgA}` },
        { id: orgB, name: 'B', slug: `b-${orgB}` },
      ],
    });
    for (const orgId of [orgA, orgB]) {
      await runWithOrgContext(owner, orgId, (tx) => tx.project.create({ data: { orgId, name: 'P', key: 'P' } }));
    }
  });

  it('XT-26: no context => 0 rows', async () => {
    expect(await app.project.count()).toBe(0);
  });

  it('XT-27: context A cannot insert org B rows', async () => {
    await expect(
      runWithOrgContext(app, orgA, (tx) => tx.project.create({ data: { orgId: orgB, name: 'x', key: 'X' } })),
    ).rejects.toThrow();
    expect(await runWithOrgContext(app, orgA, (tx) => tx.project.count())).toBe(1);
  });

  it('XT-28: context does not leak to the next transaction', async () => {
    await runWithOrgContext(app, orgA, (tx) => tx.project.count());
    const leaked = await app.$transaction((tx) => tx.project.count());
    expect(leaked).toBe(0);
  });

  it('XT-29: every org_id table has RLS enabled + forced + policy', async () => {
    const rows = await owner.$queryRaw<{ relname: string; rls: boolean; forced: boolean; policies: bigint }[]>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
      WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.rls && r.forced && r.policies > 0n, r.relname).toBe(true);
    }
    await app.$disconnect();
    await owner.$disconnect();
  });
});
