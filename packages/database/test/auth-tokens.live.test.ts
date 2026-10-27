/**
 * ADR-005 durable token store. Hash validation is unit-tested; the live block runs as meetops_app (forced RLS)
 * and is skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL point at a migrated database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import { AuthTokenHashError, createAuthTokenRepository } from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const h = (s: string) => createHash('sha256').update(s).digest('hex');

describe('auth token repository input checks', () => {
  const repo = createAuthTokenRepository({ client: {} as never });
  it('rejects anything that is not a SHA-256 hex hash before touching the database', () => {
    for (const bad of ['plain-token', h('x').toUpperCase(), h('x').slice(1), '']) {
      expect(() => repo.consumeRefresh(randomUUID(), bad, new Date())).toThrow(AuthTokenHashError);
      expect(() => repo.peekRefresh(randomUUID(), bad)).toThrow(AuthTokenHashError);
      expect(() => repo.saveRefresh(randomUUID(), bad, randomUUID(), new Date())).toThrow(
        AuthTokenHashError,
      );
    }
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('auth token repository (live, forced RLS)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const repo = createAuthTokenRepository({ client: app });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  const now = new Date();
  const later = new Date(now.getTime() + 30 * 86_400_000);
  const device = {
    userId: user,
    audience: 'extension' as const,
    clientId: 'abcdefghijklmnopabcdefghijklmnop',
    deviceId: randomUUID(),
    label: 'Laptop',
  };

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'Tok A', slug: `tok-a-${orgA}` },
        { id: orgB, name: 'Tok B', slug: `tok-b-${orgB}` },
      ],
    });
    await owner.user.create({ data: { id: user, email: `tok-${orgA.slice(0, 8)}@example.test` } });
  });
  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await owner.user.deleteMany({ where: { id: user } }).catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('creates a family on an upserted device and rotates refresh hashes once', async () => {
    const fam = randomUUID();
    await repo.createFamily(orgA, {
      id: fam,
      device,
      scopes: ['recordings:write'],
      createdAt: now,
      maxExpiresAt: later,
    });
    const f = await repo.findFamily(orgA, fam);
    expect(f).toMatchObject({
      id: fam,
      audience: 'extension',
      deviceLabel: 'Laptop',
      revokedAt: null,
    });
    const rt = h(randomUUID());
    await repo.saveRefresh(orgA, rt, fam, later);
    expect(await repo.peekRefresh(orgA, rt)).toEqual({ status: 'ok', familyId: fam });
    const [a, b] = await Promise.all([
      repo.consumeRefresh(orgA, rt, now),
      repo.consumeRefresh(orgA, rt, now),
    ]);
    expect([a.status, b.status].sort()).toEqual(['ok', 'reused']);
    expect(await repo.peekRefresh(orgA, rt)).toEqual({ status: 'reused', familyId: fam });
    expect(await repo.listFamilies(orgA, user, now)).toHaveLength(1);
    await repo.revokeFamily(orgA, fam, now);
    await repo.revokeFamily(orgA, fam, later);
    expect((await repo.findFamily(orgA, fam))?.revokedAt).toEqual(now);
    expect(await repo.listFamilies(orgA, user, now)).toHaveLength(0);
  });

  it('is invisible from another organization and stores no plaintext', async () => {
    const fam = randomUUID();
    await repo.createFamily(orgA, {
      id: fam,
      device,
      scopes: ['meetings:resolve'],
      createdAt: now,
      maxExpiresAt: later,
    });
    const rt = h(`other-${fam}`);
    await repo.saveRefresh(orgA, rt, fam, later);
    expect(await repo.findFamily(orgB, fam)).toBeNull();
    expect(await repo.peekRefresh(orgB, rt)).toEqual({ status: 'unknown' });
    expect(await repo.consumeRefresh(orgB, rt, now)).toEqual({ status: 'unknown' });
    await repo.revokeFamily(orgB, fam, now);
    expect((await repo.findFamily(orgA, fam))?.revokedAt).toBeNull();
    await expect(
      app.$executeRawUnsafe(`DELETE FROM auth_refresh_tokens WHERE token_hash = '${rt}'`),
    ).rejects.toThrow();
    const devices = await runWithOrganizationContext(owner, orgA, (tx) =>
      tx.authDevice.findMany({ where: { organizationId: orgA } }),
    );
    expect(devices).toHaveLength(1);
  });
});
