/**
 * Phase 5 routing helpers (integration_connection_org, integration_connections_due_for_refresh). Run as
 * meetops_app with no org context set; they must return identifiers only and never revoked rows.
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL point at a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createIntegrationConnectionRepository,
  type IntegrationSecretCipher,
} from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const cipher: IntegrationSecretCipher = {
  encrypt: async (p) => `v1.k1.${Buffer.from(p).toString('base64url') || 'e'}.x`,
  decrypt: async (e) => Buffer.from(e.split('.')[2] ?? '', 'base64url').toString(),
};

describe.skipIf(!APP_URL || !OWNER_URL)('integration routing functions (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const repo = createIntegrationConnectionRepository({ client: app, cipher });
  const org = randomUUID();

  beforeAll(async () => {
    await owner.organization.create({ data: { id: org, name: 'Route', slug: `route-${org}` } });
  });
  afterAll(async () => {
    await owner.organization.deleteMany({ where: { id: org } }).catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('resolves the org of a live connection only, and lists due rows by expiry', async () => {
    const soon = new Date(Date.now() + 60_000);
    const c = await repo.upsert(org, {
      provider: 'jira',
      displayName: 'Site',
      externalAccountId: randomUUID(),
      accessToken: 'a',
      refreshToken: 'r',
      webhookSecret: 'w',
      accessTokenExpiresAt: soon,
    });
    expect(await repo.resolveOrganization('jira', c.id)).toBe(org);
    expect(await repo.resolveOrganization('github', c.id)).toBeNull();
    expect(await repo.resolveOrganization('jira', randomUUID())).toBeNull();
    const due = await repo.listDueForRefresh(new Date(Date.now() + 120_000), 500);
    expect(due).toContainEqual({ organizationId: org, id: c.id, provider: 'jira' });
    const notDue = await repo.listDueForRefresh(new Date(Date.now() - 120_000), 500);
    expect(notDue.find((r) => r.id === c.id)).toBeUndefined();
    await repo.disconnect(org, c.id);
    expect(await repo.resolveOrganization('jira', c.id)).toBeNull();
    const after = await repo.listDueForRefresh(new Date(Date.now() + 120_000), 500);
    expect(after.find((r) => r.id === c.id)).toBeUndefined();
  });
});
