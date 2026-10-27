/**
 * #288 L-1 remainder (20261028040000): meetops_migrator owns sessions, password_resets and audit_events, and holds
 * the column grants redact_expired_ip_addresses() needs (and nothing wider for meetops_app). Needs RLS_TEST_ADMIN_URL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;
const TABLES = ['sessions', 'password_resets', 'audit_events'] as const;

describe.skipIf(!ADMIN_URL)('ip retention table ownership and column grants (live)', () => {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  afterAll(() => admin.$disconnect());

  it('meetops_migrator owns the three retention tables', async () => {
    const rows = await admin.$queryRaw<{ t: string; owner: string }[]>`
      SELECT tablename AS t, tableowner AS owner FROM pg_tables
      WHERE schemaname = current_schema() AND tablename = ANY(${[...TABLES]}::text[]) ORDER BY 1`;
    expect(rows).toEqual([...TABLES].sort().map((t) => ({ t, owner: 'meetops_migrator' })));
  });

  it('meetops_migrator can SELECT (id, ip_address, created_at) and UPDATE (ip_address) on each', async () => {
    for (const t of TABLES) {
      const [r] = await admin.$queryRaw<
        { sel_ip: boolean; sel_id: boolean; sel_at: boolean; upd_ip: boolean }[]
      >`SELECT has_column_privilege('meetops_migrator', ${t}, 'ip_address', 'SELECT') AS sel_ip,
               has_column_privilege('meetops_migrator', ${t}, 'id', 'SELECT') AS sel_id,
               has_column_privilege('meetops_migrator', ${t}, 'created_at', 'SELECT') AS sel_at,
               has_column_privilege('meetops_migrator', ${t}, 'ip_address', 'UPDATE') AS upd_ip`;
      expect([t, r]).toEqual([t, { sel_ip: true, sel_id: true, sel_at: true, upd_ip: true }]);
    }
  });

  it('meetops_app gets no ownership and no TRUNCATE on them', async () => {
    for (const t of TABLES) {
      const [r] = await admin.$queryRaw<{ trunc: boolean }[]>`
        SELECT has_table_privilege('meetops_app', ${t}, 'TRUNCATE') AS trunc`;
      expect([t, r]).toEqual([t, { trunc: false }]);
    }
  });

  it('the migration restores ownership and grants after the tables were re-owned (tester L-1 scenario)', async () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../prisma/migrations/20261028040000_geoip_retention_owner_assert/migration.sql',
      ),
      'utf8',
    );
    const [doBlock, grant] = sql
      .replace(/^--.*$/gm, '')
      .split(/\$\$;/)
      .map((x, i) => (i === 0 ? `${x}$$;` : x))
      .map((x) => x.trim());
    for (const t of TABLES)
      await admin.$executeRawUnsafe(`ALTER TABLE "${t}" OWNER TO CURRENT_USER`);
    const [lost] = await admin.$queryRaw<{ upd: boolean }[]>`
      SELECT has_column_privilege('meetops_migrator', 'sessions', 'ip_address', 'UPDATE') AS upd`;
    expect(lost).toEqual({ upd: false });
    await admin.$executeRawUnsafe(doBlock!);
    await admin.$executeRawUnsafe(grant!);
    const owners = await admin.$queryRaw<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
      WHERE schemaname = current_schema() AND tablename = ANY(${[...TABLES]}::text[])`;
    expect(owners.map((o) => o.owner)).toEqual([
      'meetops_migrator',
      'meetops_migrator',
      'meetops_migrator',
    ]);
    const [back] = await admin.$queryRaw<{ upd: boolean }[]>`
      SELECT has_column_privilege('meetops_migrator', 'sessions', 'ip_address', 'UPDATE') AS upd`;
    expect(back).toEqual({ upd: true });
  });
});
