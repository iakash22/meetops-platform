/**
 * Per-table tenant isolation (ADR-010). For every table in TENANT_TABLES, as meetops_app (NOBYPASSRLS,
 * forced RLS), proves that with organization A's context the app can neither read, update, delete, insert
 * nor re-home rows of organization B.
 *
 * Fixture rows are inserted by a superuser with session_replication_role = replica (FK triggers off) so one
 * generic row per table can be created without building every parent graph. RLS itself is never bypassed
 * for the assertions: they all run as meetops_app.
 *
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_ADMIN_URL (superuser on the migrated DB) are set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { TENANT_TABLES, runWithOrganizationContext, type TenantTable } from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;

type Col = { table_name: string; column_name: string; udt_name: string; data_type: string };

/** Column values that must satisfy table CHECK constraints. */
function override(table: string, column: string, organizationId: string): string | undefined {
  if (table === 'recording_session_chunks' && column === 'size_bytes') return '1';
  if (table === 'recording_session_chunks' && column === 'storage_key')
    return `'org/${organizationId}/isolation-test'`;
  if (table === 'transcripts' && column === 'provider') return `'unknown'`;
  return undefined;
}

function dummy(c: Col): string {
  switch (c.udt_name) {
    case 'uuid':
      return 'gen_random_uuid()';
    case 'text':
    case 'varchar':
      return `'isolation-' || gen_random_uuid()`;
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
    case 'float8':
      return '0';
    case 'bool':
      return 'false';
    case 'timestamptz':
    case 'timestamp':
      return 'now()';
    case 'date':
      return 'current_date';
    case 'jsonb':
    case 'json':
      return `'{}'`;
    default:
      if (c.data_type === 'USER-DEFINED') {
        return `(enum_range(NULL::"${c.udt_name}"))[1]`;
      }
      throw new Error(`no dummy value for ${c.table_name}.${c.column_name} (${c.udt_name})`);
  }
}

describe.skipIf(!APP_URL || !ADMIN_URL)('tenant isolation per table (live, ADR-010)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();
  /** id of org B's fixture row, per table. */
  const rowB = new Map<TenantTable, string>();

  const inOrg = <T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(app, organizationId, fn);

  beforeAll(async () => {
    await admin.organization.createMany({
      data: [
        { id: orgA, name: 'Iso A', slug: `iso-a-${orgA}` },
        { id: orgB, name: 'Iso B', slug: `iso-b-${orgB}` },
      ],
    });
    const cols = await admin.$queryRaw<Col[]>`
      SELECT table_name::text, column_name::text, udt_name::text, data_type::text
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND is_nullable = 'NO' AND column_default IS NULL
      ORDER BY table_name, ordinal_position`;
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const t of TENANT_TABLES) {
        const id = randomUUID();
        const names = ['id', 'org_id'];
        const values = [`'${id}'::uuid`, `'${orgB}'::uuid`];
        for (const c of cols.filter((x) => x.table_name === t)) {
          if (names.includes(c.column_name)) continue;
          names.push(c.column_name);
          values.push(override(t, c.column_name, orgB) ?? dummy(c));
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO "${t}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${values.join(', ')})`,
        );
        rowB.set(t, id);
      }
    });
  });

  afterAll(async () => {
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const t of TENANT_TABLES) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${t}" WHERE org_id IN ($1::uuid, $2::uuid)`,
          orgA,
          orgB,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`,
        orgA,
        orgB,
      );
    });
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('fixtures exist for every tenant table', () => {
    expect([...rowB.keys()].sort()).toEqual([...TENANT_TABLES].sort());
  });

  describe.each([...TENANT_TABLES])('%s', (t) => {
    /** audit_events is append-only: UPDATE/DELETE are revoked from the app, so they fail on privilege instead. */
    const blockedWrite =
      t === 'audit_events' ? /permission denied|append-only/ : /row-level security/;
    const count = (tx: Prisma.TransactionClient, id: string) =>
      tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${t}" WHERE id = $1::uuid`,
        id,
      );

    it('owner organization (B) sees its row; organization A sees nothing', async () => {
      const id = rowB.get(t)!;
      const [own] = await inOrg(orgB, (tx) => count(tx, id));
      const [cross] = await inOrg(orgA, (tx) => count(tx, id));
      expect(cross!.n).toBe(0n);
      // audit_events and every other tenant table allow in-org reads.
      expect(own!.n).toBe(1n);
    });

    it('organization A cannot update or delete organization B rows', async () => {
      const id = rowB.get(t)!;
      for (const sql of [
        `UPDATE "${t}" SET org_id = org_id WHERE id = $1::uuid`,
        `DELETE FROM "${t}" WHERE id = $1::uuid`,
      ]) {
        // Either RLS filters the row (0 affected) or the app role lacks the privilege (audit_events).
        const affected = await inOrg(orgA, (tx) => tx.$executeRawUnsafe(sql, id)).catch(
          (e: unknown) => {
            if (t !== 'audit_events') throw e;
            expect(String(e)).toMatch(blockedWrite);
            return 0;
          },
        );
        expect(affected).toBe(0);
      }
      const [still] = await inOrg(orgB, (tx) => count(tx, id));
      expect(still!.n).toBe(1n);
    });

    it('organization A cannot insert a row for organization B (WITH CHECK)', async () => {
      await expect(
        inOrg(orgA, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "${t}" (id, org_id) VALUES ($1::uuid, $2::uuid)`,
            randomUUID(),
            orgB,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('organization B cannot re-home its row into organization A (WITH CHECK on UPDATE)', async () => {
      const id = rowB.get(t)!;
      const moved = inOrg(orgB, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "${t}" SET org_id = $2::uuid WHERE id = $1::uuid`, id, orgA),
      );
      await expect(moved).rejects.toThrow(blockedWrite);
      const [cross] = await inOrg(orgA, (tx) => count(tx, id));
      expect(cross!.n).toBe(0n);
    });
  });
});
