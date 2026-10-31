/**
 * ADR-014 new-location alert against live Postgres as the non-bypass app role: the outbox row is written in the same
 * transaction as the session (org RLS context), with the strict payload and no IP. Skipped unless both URLs are set:
 *   TEST_DATABASE_URL (meetops_app login) and TEST_ADMIN_DATABASE_URL (owner, reads rows back only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { AuthNewLocationSigninEvent } from '@meetops/contracts';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { buildApp, Client, signupAndLogin, PASSWORD, type App } from './helpers.js';
import { MmdbGeoIpProvider } from '../src/shared/geoip/index.js';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository,
} from '../src/modules/organizations/infrastructure/prisma/prisma.repositories.js';

const url = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('./fixtures/geoip/test-city.mmdb', import.meta.url));
const LONDON = '81.2.69.142';
const SWEDEN = '89.160.20.112';

describe.skipIf(!url || !adminUrl)(
  'new-location alert (live outbox, RLS)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    let admin: DatabaseClient;
    let app: App;
    let peer = LONDON;
    const email = `newloc-${randomUUID().slice(0, 8)}@example.com`;

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: url! });
      admin = createPrismaClient({ databaseUrl: adminUrl! });
      app = await buildApp({
        users: new PrismaUserRepository(db),
        sessions: new PrismaSessionRepository(db),
        oneTimeTokens: new PrismaOneTimeTokenRepository(db),
        organizations: new PrismaOrganizationRepository(db),
        memberships: new PrismaMembershipRepository(db),
        invitations: new PrismaInvitationRepository(db),
        audit: new PrismaAuditLog(db),
        geoIp: new MmdbGeoIpProvider(FIXTURE),
      });
      const inject = app.inject.bind(app) as (o: object) => ReturnType<App['inject']>;
      (app as unknown as { inject: (o: object) => unknown }).inject = (o: object) =>
        inject({ ...o, remoteAddress: peer });
    });
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      await admin?.$disconnect();
    });

    it('baseline and same-country sign-ins write nothing; a new country writes one strict, IP-free outbox row', async () => {
      const c = await signupAndLogin(app, email);
      expect((await c.post('/orgs', { name: 'Geo Live' })).statusCode).toBe(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      const rows = () =>
        admin.outboxEvent.findMany({
          where: { aggregateId: user.id, eventType: 'auth.new_location_signin' },
        });
      const login = async () =>
        expect(
          (await new Client(app).post('/auth/login', { email, password: PASSWORD })).statusCode,
        ).toBe(200);
      await login();
      expect(await rows()).toHaveLength(0);
      peer = SWEDEN;
      await login();
      const out = await rows();
      expect(out).toHaveLength(1);
      const [e] = out;
      expect(e).toMatchObject({ aggregateType: 'user', status: 'pending' });
      expect(Value.Check(AuthNewLocationSigninEvent, e!.payload)).toBe(true);
      expect(e!.payload).toMatchObject({ countryCode: 'SE', reason: 'new_country' });
      expect(JSON.stringify(e)).not.toContain(SWEDEN);
      expect(JSON.stringify(e)).not.toContain(LONDON);
      // Same transaction: the session the event names exists, in the same org.
      const s = await admin.session.findUniqueOrThrow({
        where: { id: (e!.payload as { sessionId: string }).sessionId },
      });
      expect(s.activeOrgId).toBe(e!.organizationId);
      // Repeat from Sweden: deduped by the per-location limit.
      await login();
      expect(await rows()).toHaveLength(1);
    });
  },
);
