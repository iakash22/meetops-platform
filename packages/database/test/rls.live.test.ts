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

describe.skipIf(!APP_URL || !OWNER_URL)('invitation definer functions (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const tokenHash = `hash-${randomUUID()}`;
  const expiredHash = `hash-${randomUUID()}`;

  it('setup', async () => {
    await owner.organization.create({ data: { id: orgId, name: 'Inv', slug: `inv-${orgId}` } });
    await owner.user.createMany({
      data: [
        { id: userId, email: `invitee-${orgId}@example.test` },
        { id: otherUserId, email: `other-${orgId}@example.test` },
      ],
    });
    await runWithOrgContext(owner, orgId, (tx) =>
      tx.invitation.createMany({
        data: [
          { orgId, email: `Invitee-${orgId}@example.test`, role: 'member', tokenHash, expiresAt: new Date(Date.now() + 3_600_000) },
          { orgId, email: `invitee-${orgId}@example.test`, tokenHash: expiredHash, expiresAt: new Date(Date.now() - 1000) },
        ],
      }),
    );
  });

  it('app cannot read invitations directly without org context', async () => {
    expect(await app.invitation.count()).toBe(0);
  });

  it('lookup by token hash returns minimal fields across RLS', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`SELECT * FROM lookup_invitation_by_token_hash(${tokenHash})`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['email', 'expires_at', 'id', 'org_id', 'role', 'status']);
    expect(rows[0]?.org_id).toBe(orgId);
    const none = await app.$queryRaw<unknown[]>`SELECT * FROM lookup_invitation_by_token_hash(${'nope'})`;
    expect(none).toHaveLength(0);
  });

  it('accept rejects wrong user email and expired tokens', async () => {
    await expect(app.$queryRaw`SELECT * FROM accept_invitation(${tokenHash}, ${otherUserId}::uuid)`).rejects.toThrow(/invitation_invalid/);
    await expect(app.$queryRaw`SELECT * FROM accept_invitation(${expiredHash}, ${userId}::uuid)`).rejects.toThrow(/invitation_invalid/);
  });

  it('accept creates membership, marks accepted, audits; second accept fails', async () => {
    const rows = await app.$queryRaw<{ membership_id: string; org_id: string; role: string }[]>`
      SELECT * FROM accept_invitation(${tokenHash}, ${userId}::uuid)`;
    expect(rows[0]?.org_id).toBe(orgId);
    expect(rows[0]?.role).toBe('member');
    const state = await runWithOrgContext(app, orgId, async (tx) => ({
      m: await tx.membership.count({ where: { userId } }),
      inv: await tx.invitation.findFirst({ where: { tokenHash } }),
      audit: await tx.auditEvent.count({ where: { action: 'invitation.accepted' } }),
    }));
    expect(state).toMatchObject({ m: 1, audit: 1 });
    expect(state.inv?.status).toBe('accepted');
    await expect(app.$queryRaw`SELECT * FROM accept_invitation(${tokenHash}, ${userId}::uuid)`).rejects.toThrow(/invitation_invalid/);
  });

  it('PUBLIC cannot execute the functions', async () => {
    const rows = await owner.$queryRaw<{ fn: string; pub: boolean; app: boolean }[]>`
      SELECT p.proname AS fn,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('meetops_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p WHERE p.proname IN ('lookup_invitation_by_token_hash', 'accept_invitation')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.fn, r.pub, r.app]).toEqual([r.fn, false, true]);
    await app.$disconnect();
    await owner.$disconnect();
  });
});

const RELAY_URL = process.env.RLS_TEST_RELAY_URL;

describe.skipIf(!RELAY_URL || !OWNER_URL)('outbox relay role (live)', () => {
  const relay = new PrismaClient({ datasources: { db: { url: RELAY_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgs = [randomUUID(), randomUUID()];

  it('setup one pending event per org', async () => {
    for (const id of orgs) {
      await owner.organization.create({ data: { id, name: 'R', slug: `r-${id}` } });
      await runWithOrgContext(owner, id, (tx) =>
        tx.outboxEvent.create({
          data: { orgId: id, aggregateType: 'meeting', aggregateId: randomUUID(), eventType: 'meeting.created', payload: {} },
        }),
      );
    }
  });

  it('reads pending events across orgs without org context and marks them published', async () => {
    const pending = await relay.outboxEvent.findMany({ where: { orgId: { in: orgs }, status: 'pending' } });
    expect(pending.map((e) => e.orgId).sort()).toEqual([...orgs].sort());
    const res = await relay.outboxEvent.updateMany({
      where: { id: { in: pending.map((e) => e.id) } },
      data: { status: 'published', publishedAt: new Date(), attempts: { increment: 1 } },
    });
    expect(res.count).toBe(2);
  });

  it('cannot touch other tables or insert/delete/change payload', async () => {
    await expect(relay.meeting.count()).rejects.toThrow(/permission denied/);
    await expect(relay.organization.count()).rejects.toThrow(/permission denied/);
    await expect(relay.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } })).rejects.toThrow(/permission denied/);
    await expect(
      relay.outboxEvent.create({ data: { orgId: orgs[0] ?? '', aggregateType: 'x', aggregateId: randomUUID(), eventType: 'x', payload: {} } }),
    ).rejects.toThrow(/permission denied/);
    await expect(relay.$executeRaw`UPDATE outbox_events SET payload = '{}'::jsonb WHERE false`).rejects.toThrow(/permission denied/);
    await relay.$disconnect();
    await owner.$disconnect();
  });
});
