/**
 * Prisma consent-settings repository + HTTP against live Postgres.
 * Skipped unless TEST_DATABASE_URL is set. Live runs may use only drill_* databases on 127.0.0.1:55432.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { DEFAULT_CONSENT_SETTINGS_MODE, DEFAULT_RETENTION_DAYS } from '@meetops/contracts';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository,
} from '../src/modules/organizations/infrastructure/prisma/prisma.repositories.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';
import { PrismaConsentSettingsRepository } from '../src/modules/consent-settings/infrastructure/prisma.repository.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('consent settings Prisma repository (live)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  let app: App;
  const sfx = randomUUID().slice(0, 8);
  const email = (n: string) => `${n}-${sfx}@example.com`;

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    app = await buildApp({
      users: new PrismaUserRepository(db),
      sessions: new PrismaSessionRepository(db),
      organizations: new PrismaOrganizationRepository(db),
      memberships: new PrismaMembershipRepository(db),
      invitations: new PrismaInvitationRepository(db),
      audit: new PrismaAuditLog(db),
      oneTimeTokens: new PrismaOneTimeTokenRepository(db),
      consentSettings: new PrismaConsentSettingsRepository(db),
      db,
      rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it('GET defaults then PATCH persists and is visible on GET', async () => {
    const owner = await signupAndLogin(app, email('owner'));
    const org = (await owner.post('/orgs', { name: `Consent ${sfx}` })).json().organization
      .id as string;
    const get = await owner.get(`/orgs/${org}/settings/consent`);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      mode: DEFAULT_CONSENT_SETTINGS_MODE,
      retentionDays: DEFAULT_RETENTION_DAYS,
    });
    const patch = await owner.patch(`/orgs/${org}/settings/consent`, {
      retentionDays: 45,
      mode: 'all_parties_notified',
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      retentionDays: 45,
      mode: 'all_parties_notified',
    });
    const again = await owner.get(`/orgs/${org}/settings/consent`);
    expect(again.json()).toMatchObject({ retentionDays: 45, mode: 'all_parties_notified' });
  });

  it('concurrent notice PATCHes serialise on the row lock (first write too): no lost bump', async () => {
    const owner = await signupAndLogin(app, email('race'));
    const org = (await owner.post('/orgs', { name: `Consent race ${sfx}` })).json().organization
      .id as string;
    // No settings row yet: the first writers race on the insert of the default row, then on its lock.
    const notices = Array.from({ length: 5 }, (_, i) => `Race notice ${i + 1}.`);
    const res = await Promise.all(
      notices.map((noticeText) => owner.patch(`/orgs/${org}/settings/consent`, { noticeText })),
    );
    const bodies = res.map((r) => {
      expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
      return r.json<{ noticeText: string; currentConsentVersion: string }>();
    });
    const versions = bodies.map((b) => b.currentConsentVersion);
    // Five distinct versions: every writer read the previous writer's committed row.
    expect(new Set(versions).size).toBe(5);
    const rank = (v: string) => Number(v.split('.')[1] ?? '1');
    const last = bodies.reduce((a, b) =>
      rank(b.currentConsentVersion) > rank(a.currentConsentVersion) ? b : a,
    );
    expect(versions.map(rank).sort()).toEqual([1, 2, 3, 4, 5]);
    const stored = await owner.get(`/orgs/${org}/settings/consent`);
    expect(stored.json()).toMatchObject({
      noticeText: last.noticeText,
      currentConsentVersion: last.currentConsentVersion,
    });
  });
});
