/**
 * ADR-014 IP retention + geo columns. RLS_TEST_ADMIN_URL (superuser) is only used to read audit rows back.
 * Input check is unit-tested; the live block runs as meetops_app (forced RLS on
 * audit_events) and is skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL point at a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { redactExpiredIpAddresses } from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;

describe('redactExpiredIpAddresses input checks', () => {
  it('rejects non-positive or fractional days before touching the database', async () => {
    for (const d of [0, -1, 1.5, 29, Number.NaN]) {
      await expect(redactExpiredIpAddresses({} as never, d)).rejects.toThrow(RangeError);
    }
  });
});

describe.skipIf(!APP_URL || !OWNER_URL || !ADMIN_URL)('ip retention (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  // Superuser, only to read audit rows back (forced RLS hides org-NULL rows from the migrator).
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const user = randomUUID();
  const oldSession = randomUUID();
  const newSession = randomUUID();
  afterAll(async () => {
    await owner.$executeRaw`DELETE FROM users WHERE id = ${user}::uuid`;
    await Promise.all([app.$disconnect(), owner.$disconnect(), admin.$disconnect()]);
  });

  it('nulls raw IPs older than the cutoff, keeps geo, and leaves audit rows otherwise unchanged', async () => {
    await owner.$executeRaw`INSERT INTO users (id, email, name, updated_at)
      VALUES (${user}::uuid, ${`${user}@example.test`}, 'Geo', now())`;
    const old = new Date(Date.now() - 31 * 86_400_000);
    for (const [id, createdAt] of [
      [oldSession, old],
      [newSession, new Date()],
    ] as const) {
      await owner.$executeRaw`INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at,
          absolute_expires_at, created_at, updated_at, geo_city, geo_country_code, geo_approximate)
        VALUES (${id}::uuid, ${user}::uuid, ${randomUUID()}, '203.0.113.9', now() + interval '1 day',
          now() + interval '1 day', ${createdAt}, now(), 'Pune', 'IN', true)`;
    }
    const [{ id: auditId }] = await app.$queryRaw<{ id: string }[]>`
      SELECT public.record_global_auth_event('auth.login_succeeded', ${user}::uuid, 'session', ${oldSession},
        '{}'::jsonb, '203.0.113.9', 'ua', 'Pune', 'Maharashtra', 'India', 'in') AS id`;
    // Back-date the audit row through the maintenance hatch (owner is a migrator member).
    await owner.$transaction([
      owner.$executeRaw`SET LOCAL meetops.audit_maintenance = 'on'`,
      owner.$executeRaw`ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY`,
      owner.$executeRaw`UPDATE audit_events SET created_at = ${old} WHERE id = ${auditId}::uuid`,
      owner.$executeRaw`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`,
    ]);

    // The app cannot update audit_events directly.
    await expect(
      app.$executeRaw`UPDATE audit_events SET ip_address = NULL WHERE id = ${auditId}::uuid`,
    ).rejects.toThrow();

    const res = await redactExpiredIpAddresses(app, 30);
    expect(res.sessionsRedacted).toBeGreaterThanOrEqual(1);
    expect(res.auditEventsRedacted).toBeGreaterThanOrEqual(1);

    const sessions = await owner.$queryRaw<
      { id: string; ip_address: string | null; geo_city: string | null }[]
    >`
      SELECT id::text, ip_address, geo_city FROM sessions WHERE user_id = ${user}::uuid`;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get(oldSession)).toMatchObject({ ip_address: null, geo_city: 'Pune' });
    expect(byId.get(newSession)?.ip_address).toBe('203.0.113.9');

    const audit = await admin.$queryRaw<Record<string, unknown>[]>`
      SELECT ip_address, user_agent, geo_city, geo_region, geo_country, geo_country_code, geo_approximate
      FROM audit_events WHERE id = ${auditId}::uuid`;
    expect(audit[0]).toEqual({
      ip_address: null,
      user_agent: 'ua',
      geo_city: 'Pune',
      geo_region: 'Maharashtra',
      geo_country: 'India',
      geo_country_code: 'IN',
      geo_approximate: true,
    });
    // The SQL function refuses a window shorter than 30 days even if called directly.
    await expect(
      app.$queryRaw`SELECT * FROM public.redact_expired_ip_addresses(1)`,
    ).rejects.toThrow();
    // Idempotent.
    expect((await redactExpiredIpAddresses(app, 30)).auditEventsRedacted).toBe(0);
  });
});
