/**
 * ADR-014 IP retention, session purge and geo columns. Input checks are unit tests; the live block needs
 * RLS_TEST_APP_URL (meetops_app) and RLS_TEST_ADMIN_URL (superuser: seeds rows, reads audit rows back, and acts as
 * meetops_migrator through SET LOCAL ROLE, so no migrator login is needed) pointing at a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { purgeExpiredSessions, redactExpiredIpAddresses } from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
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

describe('purgeExpiredSessions input checks', () => {
  it('rejects bad windows and batch sizes before touching the database', async () => {
    for (const d of [0, 91, 1.5, Number.NaN]) {
      await expect(purgeExpiredSessions({} as never, d)).rejects.toThrow(RangeError);
    }
    await expect(purgeExpiredSessions({} as never, 90, { batchSize: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe.skipIf(!APP_URL || !ADMIN_URL)('ip retention (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
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
    await admin.$executeRaw`INSERT INTO users (id, email, name, updated_at)
      VALUES (${user}::uuid, ${`${user}@example.test`}, 'Geo', now())`;
    for (const [id, createdAt] of [
      ...oldSessions.map((id) => [id, old] as const),
      [newSession, new Date()] as const,
    ]) {
      await admin.$executeRaw`INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at,
          absolute_expires_at, created_at, updated_at, geo_city, geo_country_code, geo_approximate)
        VALUES (${id}::uuid, ${user}::uuid, ${randomUUID()}, ${IP}, now() + interval '1 day',
          now() + interval '1 day', ${createdAt}, now(), 'Pune', 'IN', true)`;
    }
    for (const [id, createdAt] of [
      [oldReset, old],
      [newReset, new Date()],
    ] as const) {
      await admin.$executeRaw`INSERT INTO password_resets (id, user_id, token_hash, expires_at, ip_address, created_at)
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
    await admin.$executeRaw`DELETE FROM users WHERE id = ${user}::uuid`;
    await Promise.all([app.$disconnect(), admin.$disconnect()]);
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
    // Portable: the admin connection drops to meetops_migrator with SET LOCAL ROLE (current_user = migrator).
    const asMigrator = (sql: ReturnType<typeof admin.$executeRaw>) =>
      admin.$transaction([
        admin.$executeRaw`SET LOCAL ROLE meetops_migrator`,
        admin.$executeRaw`SELECT set_config('meetops.audit_ip_retention', 'on', true)`,
        sql,
      ]);
    // Changing the IP to another value: the policy WITH CHECK and the trigger both refuse it.
    await expect(
      asMigrator(
        admin.$executeRaw`UPDATE audit_events SET ip_address = '198.51.100.1' WHERE id = ${oldAudit}::uuid`,
      ),
    ).rejects.toThrow();
    // Nulling IP together with another column: refused by the trigger.
    await expect(
      asMigrator(
        admin.$executeRaw`UPDATE audit_events SET ip_address = NULL, user_agent = 'x' WHERE id = ${oldAudit}::uuid`,
      ),
    ).rejects.toThrow();
    // A row under 30 days: not visible to the scoped policy, so nothing is updated.
    const n = await asMigrator(
      admin.$executeRaw`UPDATE audit_events SET ip_address = NULL WHERE id = ${newAudit}::uuid`,
    );
    expect(n[2]).toBe(0);
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

    const sessions = await admin.$queryRaw<
      { id: string; ip_address: string | null; geo_city: string | null }[]
    >`
      SELECT id::text, ip_address, geo_city FROM sessions WHERE user_id = ${user}::uuid`;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const id of oldSessions)
      expect(byId.get(id)).toMatchObject({ ip_address: null, geo_city: 'Pune' });
    expect(byId.get(newSession)?.ip_address).toBe(IP);

    const resets = await admin.$queryRaw<{ id: string; ip_address: string | null }[]>`
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

  it('purges sessions that ended over 90 days ago (with their geo), keeps recent and active ones; idempotent', async () => {
    const ended = new Date(Date.now() - 91 * 86_400_000);
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const [oldRevoked, oldExpired, recentRevoked, active] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const add = (id: string, revokedAt: Date | null, absExp: Date) =>
      admin.$executeRaw`INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, revoked_at,
          created_at, updated_at, geo_city, geo_country_code, geo_approximate)
        VALUES (${id}::uuid, ${user}::uuid, ${randomUUID()}, ${absExp}, ${absExp}, ${revokedAt},
          ${new Date(Date.now() - 200 * 86_400_000)}, now(), 'Pune', 'IN', true)`;
    await add(oldRevoked, ended, new Date(Date.now() + 86_400_000));
    await add(oldExpired, null, ended);
    await add(recentRevoked, recent, new Date(Date.now() + 86_400_000));
    await add(active, null, new Date(Date.now() + 86_400_000));
    const r = await purgeExpiredSessions(app, 90, { batchSize: 1 });
    expect(r.sessionsPurged).toBeGreaterThanOrEqual(2);
    const left = new Set(
      (
        await admin.$queryRaw<
          { id: string }[]
        >`SELECT id::text FROM sessions WHERE user_id = ${user}::uuid`
      ).map((x) => x.id),
    );
    expect(left.has(oldRevoked)).toBe(false);
    expect(left.has(oldExpired)).toBe(false);
    expect(left.has(recentRevoked)).toBe(true);
    expect(left.has(active)).toBe(true);
    expect((await purgeExpiredSessions(app, 90)).sessionsPurged).toBe(0);
  });

  it('meetops_migrator holds explicit UPDATE(ip_address) on sessions, password_resets and audit_events', async () => {
    const g = await admin.$queryRaw<{ t: string; ok: boolean }[]>`
      SELECT t, has_column_privilege('meetops_migrator', t, 'ip_address', 'UPDATE') AS ok
      FROM unnest(ARRAY['sessions', 'password_resets', 'audit_events']) AS t`;
    for (const r of g) expect(r.ok, r.t).toBe(true);
  });
});
