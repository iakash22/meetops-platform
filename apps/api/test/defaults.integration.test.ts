/**
 * BE-1 defaults path against live Postgres (RLS, meetops_app role) + Redis. Skipped unless both
 * TEST_DATABASE_URL and TEST_REDIS_URL are set:
 *   TEST_DATABASE_URL=postgresql://meetops_app:...@127.0.0.1:5432/meetops TEST_REDIS_URL=redis://127.0.0.1:6379 \
 *     pnpm vitest run test/defaults.integration.test.ts
 * No repository is injected: createServer picks Prisma and Redis from the URLs, as in deployment.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@meetops/database';
import { createServer } from '../src/server.js';
import { RecordingMailTransport } from '../src/modules/auth/domain/mail-jobs.js';
import { fakeHasher, ORIGIN, PASSWORD } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

type Inst = Awaited<ReturnType<typeof boot>>;

/** One API instance on the defaults path ('development': relaxed cookies/CSRF secret, no mail queue). */
async function boot() {
  const mail = new RecordingMailTransport();
  const app = createServer({
    nodeEnv: 'development',
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    deps: { hasher: fakeHasher, mailTransport: mail },
  });
  await app.ready();
  return { app, mail };
}

/** Cookie-jar client; cookie names are read from the response (development drops __Host-). */
class Jar {
  private jar = new Map<string, string>();
  // A per-run source IP keeps the per-IP limits in shared Redis from leaking across runs.
  constructor(private readonly ip: string) {}
  private absorb(res: Awaited<ReturnType<Inst['app']['inject']>>) {
    for (const c of res.cookies) {
      if (c.value === '') this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    return res;
  }
  private get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private get csrf() {
    return [...this.jar].find(([k]) => k.endsWith('meetops_csrf'))?.[1];
  }
  async get(i: Inst, url: string) {
    return this.absorb(
      await i.app.inject({
        method: 'GET',
        url,
        remoteAddress: this.ip,
        headers: { cookie: this.cookie },
      }),
    );
  }
  async post(i: Inst, url: string, payload: object) {
    if (!this.csrf) await this.get(i, '/auth/csrf');
    return this.absorb(
      await i.app.inject({
        method: 'POST',
        url,
        payload,
        remoteAddress: this.ip,
        headers: { cookie: this.cookie, origin: ORIGIN, 'x-csrf-token': this.csrf! },
      }),
    );
  }
}

describe.skipIf(!databaseUrl || !redisUrl)(
  'BE-1 persistent defaults (live Postgres + Redis)',
  { timeout: 60_000 },
  () => {
    const sfx = randomUUID().slice(0, 8);
    const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
    const email = (n: string) => `be1-${n}-${sfx}@example.com`;
    const open: Inst[] = [];
    const start = async () => {
      const i = await boot();
      open.push(i);
      return i;
    };
    const stop = async (i: Inst) => {
      open.splice(open.indexOf(i), 1);
      await i.app.close();
    };

    afterAll(async () => {
      await Promise.all(open.map((i) => i.app.close()));
      // Drop this run's counters (keys carry the run's IP or email suffix).
      const r = new Redis(redisUrl!);
      const keys = [...(await r.keys(`meetops:*${ip}*`)), ...(await r.keys(`meetops:*${sfx}*`))];
      if (keys.length) await r.del(...keys);
      await r.quit();
    });

    it('users, sessions and audit events survive an API restart (Prisma is the default)', async () => {
      const a = await start();
      const c = new Jar(ip);
      expect(
        (
          await c.post(a, '/auth/signup', {
            name: 'BE1 User',
            email: email('owner'),
            password: PASSWORD,
          })
        ).statusCode,
      ).toBe(202);
      const token = a.mail.lastToken(email('owner'), 'email_verification')!;
      expect((await c.post(a, '/auth/verify-email', { token })).statusCode).toBe(204);
      expect(
        (await c.post(a, '/auth/login', { email: email('owner'), password: PASSWORD })).statusCode,
      ).toBe(200);
      const org = await c.post(a, '/orgs', { name: `BE1 ${sfx}` });
      expect(org.statusCode).toBe(201);
      const orgId = org.json().organization.id as string;
      await stop(a);

      // New process-equivalent: fresh Prisma + Redis clients from the same URLs.
      const b = await start();
      const session = await c.get(b, '/auth/session');
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ activeOrganizationId: orgId, role: 'owner' });

      // Read back as the app role under the ADR-010 tenant setting (forced RLS).
      const db = createPrismaClient({ databaseUrl: databaseUrl! });
      try {
        const audits = await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${orgId}, true)`;
          return tx.auditEvent.findMany({
            where: { organizationId: orgId },
            select: { action: true },
          });
        });
        expect(audits.map((x) => x.action)).toContain('org.create');
      } finally {
        await db.$disconnect();
      }
    });

    it('the rate limit is shared by two instances through Redis (G12)', async () => {
      const [a, b] = await Promise.all([start(), start()]);
      const target = email('reset');
      // resetRequestPerEmail is 3/hour: three hits on A, the fourth on B is refused.
      for (let n = 0; n < 3; n++) {
        expect(
          (await new Jar(ip).post(a, '/auth/forgot-password', { email: target })).statusCode,
        ).toBe(202);
      }
      const refused = await new Jar(ip).post(b, '/auth/forgot-password', { email: target });
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });
  },
);
