/**
 * Live: PostgresOrgConfigStore on ai_org_config as meetops_app (NOBYPASSRLS, forced RLS). Covers updated_by_id,
 * budget rounding, a malformed row failing closed without leaking stored values, and reads without org context.
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL are set (see packages/database/docs/ci-live-db.md).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiOrgConfigActorError,
  createAiOrgConfigRepository,
  createPrismaClient,
  withOrganizationContext,
} from '@meetops/database';
import { PostgresOrgConfigStore } from '../src/ai/durable-stores.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('PostgresOrgConfigStore (live, forced RLS)', () => {
  const app = createPrismaClient({ databaseUrl: APP_URL ?? '' });
  const owner = createPrismaClient({ databaseUrl: OWNER_URL ?? '' });
  const store = new PostgresOrgConfigStore(createAiOrgConfigRepository({ client: app }));
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  // ai_org_config has FORCE RLS, so even the owner role needs the org context.
  const ownerRow = (org: string) =>
    withOrganizationContext(
      org,
      (tx) => tx.aiOrganizationConfig.findUnique({ where: { organizationId: org } }),
      { client: owner },
    );

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'OrgCfg A', slug: `orgcfg-a-${orgA}` },
        { id: orgB, name: 'OrgCfg B', slug: `orgcfg-b-${orgB}` },
      ],
    });
    await owner.user.create({
      data: { id: userA, email: `orgcfg-${userA}@example.test`, name: 'OrgCfg' },
    });
    // userA is a member of orgA only.
    await withOrganizationContext(
      orgA,
      (tx) =>
        tx.membership.create({ data: { organizationId: orgA, userId: userA, role: 'admin' } }),
      { client: owner },
    );
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await owner.user.deleteMany({ where: { id: userA } }).catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('records updated_by_id for a user actor, null for a system actor, and rounds the budget to cents', async () => {
    await store.put(
      {
        organizationId: orgA,
        defaults: {},
        features: {},
        approvedProviders: ['gemini'],
        credentialRefs: {},
        monthlyBudgetUsd: 12.345,
      },
      { updatedById: userA },
    );
    let row = await ownerRow(orgA);
    expect(row?.updatedById).toBe(userA);
    expect(row?.monthlyBudgetUsd?.toFixed(2)).toBe((12.345).toFixed(2));
    expect((await store.get(orgA))?.approvedProviders).toEqual(['gemini']);

    await store.put(
      {
        organizationId: orgA,
        defaults: {},
        features: {},
        approvedProviders: [],
        credentialRefs: {},
      },
      { updatedById: 'system:transcription-worker' },
    );
    row = await ownerRow(orgA);
    expect(row?.updatedById).toBeNull();
    expect(row?.monthlyBudgetUsd).toBeNull();
  });

  it('#429: refuses an updated_by_id that is not an active member of the organization', async () => {
    const cfg = (org: string) => ({
      organizationId: org,
      defaults: {},
      features: {},
      approvedProviders: ['gemini' as const],
      credentialRefs: {},
    });
    // userA exists but belongs to orgA, not orgB.
    await expect(store.put(cfg(orgB), { updatedById: userA })).rejects.toBeInstanceOf(
      AiOrgConfigActorError,
    );
    // A uuid that is no user at all.
    await expect(store.put(cfg(orgB), { updatedById: randomUUID() })).rejects.toBeInstanceOf(
      AiOrgConfigActorError,
    );
    expect(await ownerRow(orgB)).toBeNull();
    // A soft-deleted membership no longer counts.
    await withOrganizationContext(
      orgA,
      (tx) =>
        tx.membership.updateMany({
          where: { organizationId: orgA, userId: userA },
          data: { deletedAt: new Date() },
        }),
      { client: owner },
    );
    await expect(store.put(cfg(orgA), { updatedById: userA })).rejects.toBeInstanceOf(
      AiOrgConfigActorError,
    );
    await withOrganizationContext(
      orgA,
      (tx) =>
        tx.membership.updateMany({
          where: { organizationId: orgA, userId: userA },
          data: { deletedAt: null },
        }),
      { client: owner },
    );
    await store.put(cfg(orgA), { updatedById: userA });
    expect((await ownerRow(orgA))?.updatedById).toBe(userA);
  });

  it('a malformed stored row fails closed without leaking stored values', async () => {
    const leak = 'sk-live-should-never-appear';
    await withOrganizationContext(
      orgB,
      (tx) =>
        tx.aiOrganizationConfig.upsert({
          where: { organizationId: orgB },
          create: { organizationId: orgB, config: { credentialRefs: { gemini: leak } } },
          update: { config: { credentialRefs: { gemini: leak } } },
        }),
      { client: owner },
    );
    const err = await store.get(orgB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid/);
    expect((err as Error).message).not.toContain(leak);
    expect(JSON.stringify(err)).not.toContain(leak);
  });

  it('a read without org context sees no rows under forced RLS', async () => {
    expect(await app.$queryRaw<unknown[]>`SELECT 1 FROM "ai_org_config"`).toHaveLength(0);
    expect(await app.aiOrganizationConfig.findMany()).toHaveLength(0);
    // With the org context the same client does see the rows, so the empty result is RLS, not an empty table.
    expect(await ownerRow(orgA)).not.toBeNull();
    expect(await ownerRow(orgB)).not.toBeNull();
  });
});
