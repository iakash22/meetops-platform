/**
 * ADR-014 IP retention + geo columns. Input checks are unit tests; the live block needs RLS_TEST_APP_URL (meetops_app),
 * RLS_TEST_OWNER_URL (meetops_migrator) and RLS_TEST_ADMIN_URL (superuser, only to seed/read audit rows back, since
 * forced RLS hides org-NULL audit rows from the migrator) pointing at a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { redactExpiredIpAddresses } from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;
const IP = '203.0.113.9';

describe('redactExpiredIpAddresses input checks', () => {
  it('rejects windows under 30 days and bad batch sizes before touching the database', async () => {
    for (const d of [0, -1, 1.5, 29, Number.NaN]) {
      await expect(redactExpiredIpAddresses({} as never, d)).rejects.toThrow(RangeError);
    }
    for (const b of [0, 10_001, 2.5]) {
      await expect(redactExpiredIpAddresses({} as never, 30, { batchSize: b })).rejects.toThrow(
        RangeError,
      );
    }
  });
});

describe.skipIf(!APP_URL || !OWNER_URL || !ADMIN_URL)('ip retention (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const user = randomUUID();
  const old = new Date(Date.now() - 31 * 86_400_000);
  const oldSessions = [randomUUID(), randomUUID(), randomUUID()];
  const newSession = randomUUID();
  const oldReset = randomUUID();
  const newReset = randomUUID();
  let oldAudit = '';
  let newAudit = '';

  const audit = async (id: string) =>
    (
      await admin.$queryRaw<Record<string, unknown>[]>`
        SELECT ip_address, user_agent, geo_city, geo_region, geo_country, geo_country_code, geo_approximate
        FROM audit_events WHERE id = ${id}::uuid`
    )[0];
  const authEvent = async () =>
    (
      await app.$queryRaw<{ id: string }[]>`
        SELECT public.record_global_auth_event('auth.login_succeeded', ${user}::uuid, 'session', ${randomUUID()},
          '{}'::jsonb, ${IP}, 'ua', 'Pune', 'Maharashtra', 'India', 'in')::text AS id`
    )[0]!.id;

  beforeAll(async () => {
    await owner.$executeRaw`INSERT INTO users (id, email, name, updated_at)
      VALUES (${user}::uuid, ${`${user}@example.test`}, 'Geo', now())`;
    for (const [id, createdAt] of [
      ...oldSessions.map((id) => [id, old] as const),
      [newSession, new Date()] as const,
    ]) {
      await owner.$executeRaw`INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at,
          absolute_expires_at, created_at, updated_at, geo_city, geo_country_code, geo_approximate)
        VALUES (${id}::uuid, ${user}::uuid, ${randomUUID()}, ${IP}, now() + interval '1 day',
          now() + interval '1 day', ${createdAt}, now(), 'Pune', 'IN', true)`;
    }
    for (const [id, createdAt] of [
      [oldReset, old],
      [newReset, new Date()],
    ] as const) {
      await owner.$executeRaw`INSERT INTO password_resets (id, user_id, token_hash, expires_at, ip_address, created_at)
        VALUES (${id}::uuid, ${user}::uuid, ${randomUUID()}, now(), ${IP}, ${createdAt})`;
    }
    oldAudit = await authEvent();
    newAudit = await authEvent();
    // Back-date one audit row through the existing superuser-only path (test setup only).
    await admin.$transaction([
      admin.$executeRaw`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      admin.$executeRaw`UPDATE audit_events SET created_at = ${old} WHERE id = ${oldAudit}::uuid`,
      admin.$executeRaw`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`,
    ]);
  });
  afterAll(async () => {
    await owner.$executeRaw`DELETE FROM users WHERE id = ${user}::uuid`;
    await Promise.all([app.$disconnect(), owner.$disconnect(), admin.$disconnect()]);
  });

  it('app role cannot UPDATE audit_events (no grant), even with the retention GUC set', async () => {
    await expect(
      app.$transaction([
        app.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        app.$executeRaw`UPDATE audit_events SET ip_address = NULL WHERE id = ${oldAudit}::uuid`,
      ]),
    ).rejects.toThrow();
  });

  it('migrator with the GUC: a non-NULL update and a <30-day row are refused; DELETE/TRUNCATE refused', async () => {
    const asMigrator = (sql: ReturnType<typeof owner.$executeRaw>) =>
      owner.$transaction([
        owner.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        sql,
      ]);
    // Changing the IP to another value: the policy WITH CHECK and the trigger both refuse it.
    await expect(
      asMigrator(
        owner.$executeRaw`UPDATE audit_events SET ip_address = '198.51.100.1' WHERE id = ${oldAudit}::uuid`,
      ),
    ).rejects.toThrow();
    // Nulling IP together with another column: refused by the trigger.
    await expect(
      asMigrator(
        owner.$executeRaw`UPDATE audit_events SET ip_address = NULL, user_agent = 'x' WHERE id = ${oldAudit}::uuid`,
      ),
    ).rejects.toThrow();
    // A row under 30 days: not visible to the scoped policy, so nothing is updated.
    const n = await owner.$transaction([
      owner.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
      owner.$executeRaw`UPDATE audit_events SET ip_address = NULL WHERE id = ${newAudit}::uuid`,
    ]);
    expect(n[1]).toBe(0);
    expect((await audit(newAudit))?.ip_address).toBe(IP);
    // Even a superuser (bypasses RLS) is stopped by the trigger for a <30-day row.
    await expect(
      admin.$transaction([
        admin.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        admin.$executeRaw`UPDATE audit_events SET ip_address = NULL WHERE id = ${newAudit}::uuid`,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.$transaction([
        admin.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        admin.$executeRaw`DELETE FROM audit_events WHERE id = ${oldAudit}::uuid`,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.$transaction([
        admin.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        admin.$executeRaw`TRUNCATE audit_events`,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('the definer function refuses windows under 30 days and is not executable by PUBLIC', async () => {
    await expect(
      app.$queryRaw`SELECT * FROM public.redact_expired_ip_addresses(1, 10)`,
    ).rejects.toThrow();
    const acl = await admin.$queryRaw<{ ok: boolean; definer: boolean; cfg: string[] | null }[]>`
      SELECT has_function_privilege('public', 'public.redact_expired_ip_addresses(integer, integer)', 'EXECUTE') AS ok,
             p.prosecdef AS definer, p.proconfig AS cfg
      FROM pg_proc p WHERE p.proname = 'redact_expired_ip_addresses'`;
    expect(acl[0]?.ok).toBe(false);
    expect(acl[0]?.definer).toBe(true);
    expect(acl[0]?.cfg).toContain('search_path=public, pg_temp');
    const force = await admin.$queryRaw<{ f: boolean }[]>`
      SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'audit_events'`;
    expect(force[0]?.f).toBe(true);
  });

  it('redacts old IPs on all three tables in batches, keeps geo, is idempotent', async () => {
    const res = await redactExpiredIpAddresses(app, 30, { batchSize: 1 });
    expect(res.sessionsRedacted).toBeGreaterThanOrEqual(oldSessions.length);
    expect(res.auditEventsRedacted).toBeGreaterThanOrEqual(1);
    expect(res.passwordResetsRedacted).toBeGreaterThanOrEqual(1);

    const sessions = await owner.$queryRaw<
      { id: string; ip_address: string | null; geo_city: string | null }[]
    >`
      SELECT id::text, ip_address, geo_city FROM sessions WHERE user_id = ${user}::uuid`;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const id of oldSessions)
      expect(byId.get(id)).toMatchObject({ ip_address: null, geo_city: 'Pune' });
    expect(byId.get(newSession)?.ip_address).toBe(IP);

    const resets = await owner.$queryRaw<{ id: string; ip_address: string | null }[]>`
      SELECT id::text, ip_address FROM password_resets WHERE user_id = ${user}::uuid`;
    expect(new Map(resets.map((r) => [r.id, r.ip_address]))).toEqual(
      new Map([
        [oldReset, null],
        [newReset, IP],
      ]),
    );

    expect(await audit(oldAudit)).toEqual({
      ip_address: null,
      user_agent: 'ua',
      geo_city: 'Pune',
      geo_region: 'Maharashtra',
      geo_country: 'India',
      geo_country_code: 'IN',
      geo_approximate: true,
    });
    expect((await audit(newAudit))?.ip_address).toBe(IP);

    const again = await redactExpiredIpAddresses(app, 30);
    expect(again).toEqual({
      sessionsRedacted: 0,
      auditEventsRedacted: 0,
      passwordResetsRedacted: 0,
    });
  });
});
