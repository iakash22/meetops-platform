/**
 * #290 M-2 / L-2: GeoIP writes against live Postgres as the non-bypass app role. Skipped unless both URLs are set:
 *   TEST_DATABASE_URL=postgresql://<meetops_app login>@.../db TEST_ADMIN_DATABASE_URL=postgresql://<owner>@.../db
 * The admin URL only reads rows back (the app role cannot SELECT global audit rows) and seeds an organization.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { buildApp, signupAndLogin, type App } from './helpers.js';
import { MmdbGeoIpProvider } from '../src/shared/geoip/index.js';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';

const url = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('./fixtures/geoip/test-city.mmdb', import.meta.url));
const LONDON = '81.2.69.142';
const SWEDEN = '89.160.20.112';

interface AuditRow {
  action: string;
  org_id: string | null;
  ip_address: string | null;
  geo_city: string | null;
  geo_country_code: string | null;
  geo_approximate: boolean | null;
  metadata: Record<string, unknown>;
}

describe.skipIf(!url || !adminUrl)(
  'GeoIP live DB writes (meetops_app, RLS)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    let admin: DatabaseClient;
    let app: App;
    let peer = LONDON;
    const sfx = randomUUID().slice(0, 8);
    const email = (n: string) => `${n}-${sfx}@example.com`;
    const auditFor = (userId: string) =>
      admin.$queryRaw<
        AuditRow[]
      >`SELECT action, org_id, ip_address, geo_city, geo_country_code, geo_approximate,
      metadata FROM audit_events WHERE actor_id = ${userId}::uuid ORDER BY created_at`;
    const userId = async (e: string) =>
      (await admin.user.findUniqueOrThrow({ where: { email: e }, select: { id: true } })).id;

    beforeAll(() => {
      db = createPrismaClient({ databaseUrl: url! });
      admin = createPrismaClient({ databaseUrl: adminUrl! });
    });
    beforeEach(async () => {
      app = await buildApp({
        users: new PrismaUserRepository(db),
        sessions: new PrismaSessionRepository(db),
        oneTimeTokens: new PrismaOneTimeTokenRepository(db),
        audit: new PrismaAuditLog(db),
        geoIp: new MmdbGeoIpProvider(FIXTURE),
        rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
      });
      const inject = app.inject.bind(app) as (o: object) => ReturnType<App['inject']>;
      (app as unknown as { inject: (o: object) => unknown }).inject = (o: object) =>
        inject({ ...o, remoteAddress: peer });
    });
    afterEach(async () => {
      peer = LONDON;
      await app?.close();
    });
    afterAll(async () => {
      await db?.$disconnect();
      await admin?.$disconnect();
    });

    it('runs as a non-bypass role', async () => {
      const [r] = await db.$queryRaw<{ su: boolean; br: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS br FROM pg_roles WHERE rolname = current_user`;
      expect(r).toEqual({ su: false, br: false });
    });

    it('M-2: org-less sign-in audit events reach audit_events with geo via record_global_auth_event', async () => {
      await signupAndLogin(app, email('glob'));
      const rows = await auditFor(await userId(email('glob')));
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(['auth.signup', 'auth.email_verified', 'auth.login_succeeded']),
      );
      const login = rows.find((r) => r.action === 'auth.login_succeeded')!;
      expect(login).toMatchObject({
        org_id: null,
        ip_address: LONDON,
        geo_city: 'London',
        geo_country_code: 'GB',
        geo_approximate: true,
      });
    });

    it('M-2: a failed login from a private IP is recorded without geo', async () => {
      await signupAndLogin(app, email('fail'));
      peer = '10.0.0.5';
      const c = await import('./helpers.js').then((m) => new m.Client(app));
      expect(
        (await c.post('/auth/login', { email: email('fail'), password: 'wrong-password-123' }))
          .statusCode,
      ).toBe(401);
      const failed = (await auditFor(await userId(email('fail')))).find(
        (r) => r.action === 'auth.login_failed',
      );
      expect(failed).toMatchObject({
        ip_address: '10.0.0.5',
        geo_city: null,
        geo_country_code: null,
        geo_approximate: null,
      });
    });

    it('L-2: session geo is written at sign-in and rewritten by updateIp when the IP moves', async () => {
      const c = await signupAndLogin(app, email('move'));
      const uid = await userId(email('move'));
      const before = await admin.session.findFirstOrThrow({
        where: { userId: uid },
        orderBy: { createdAt: 'desc' },
      });
      expect(before).toMatchObject({
        ipAddress: LONDON,
        geoCountryCode: 'GB',
        geoCity: 'London',
        geoApproximate: true,
      });
      peer = SWEDEN;
      expect((await c.get('/auth/sessions')).statusCode).toBe(200);
      const after = await admin.session.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).toMatchObject({
        ipAddress: SWEDEN,
        geoCountryCode: 'SE',
        geoApproximate: true,
      });
    });

    it('L-2: org audit events carry geo under RLS and stay invisible to other orgs', async () => {
      const uid = randomUUID();
      await admin.user.create({
        data: { id: uid, email: email('org'), name: 'Org User', passwordHash: 'x' },
      });
      const org = await admin.organization.create({
        data: { name: `geo-${sfx}`, slug: `geo-${sfx}` },
      });
      await new PrismaAuditLog(db).record({
        organizationId: org.id,
        actorId: uid,
        action: 'org.switch',
        targetType: 'organization',
        targetId: org.id,
        metadata: {},
        ip: SWEDEN,
        userAgent: 'vitest',
        geo: {
          geoCity: 'Linköping',
          geoRegion: null,
          geoCountry: 'Sweden',
          geoCountryCode: 'SE',
          geoApproximate: true,
        },
      });
      const [row] = await auditFor(uid);
      expect(row).toMatchObject({
        org_id: org.id,
        geo_city: 'Linköping',
        geo_country_code: 'SE',
        geo_approximate: true,
      });
      const other = randomUUID();
      const seen = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${other}, true)`;
        return tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM audit_events WHERE actor_id = ${uid}::uuid`;
      });
      expect(Number(seen[0]!.n)).toBe(0);
    });
  },
);
