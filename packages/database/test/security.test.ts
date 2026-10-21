import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  Prisma,
  TENANT_TABLES,
  ORG_CONTEXT_SETTING,
  runWithOrgContext,
  withOrgContext,
  type TransactionCapableClient,
} from '../src/index.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(resolve(pkgDir, 'prisma/schema.prisma'), 'utf8');
const migrationsDir = resolve(pkgDir, 'prisma/migrations');
const allSql = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((d) => readFileSync(resolve(migrationsDir, d, 'migration.sql'), 'utf8'))
  .join('\n');
const rlsSql = readFileSync(resolve(migrationsDir, '20261021110000_tenant_rls_roles/migration.sql'), 'utf8');

/** Parse models from schema: table name + body. */
const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)].map((m) => {
  const body = m[2] ?? '';
  return { name: m[1] ?? '', table: /@@map\("(\w+)"\)/.exec(body)?.[1] ?? '', body };
});
const tenantModels = models.filter((m) => /^\s+orgId\s/m.test(m.body));
const GLOBAL_TABLES = ['organizations', 'users', 'sessions'];

describe('tenant schema', () => {
  it('every table is either a tenant table or an explicitly reviewed global table', () => {
    const tenant = tenantModels.map((m) => m.table).sort();
    expect(tenant).toEqual([...TENANT_TABLES].sort());
    const others = models.map((m) => m.table).filter((t) => !tenant.includes(t));
    expect(others.sort()).toEqual([...GLOBAL_TABLES].sort());
  });

  it('org_id is required (NOT NULL) with an org FK on every tenant table', () => {
    for (const m of tenantModels) {
      expect(m.body, m.name).toMatch(/^\s+orgId\s+String\s+@map\("org_id"\)/m);
      expect(m.body, m.name).toMatch(/organization\s+Organization\s+@relation\(fields: \[orgId\]/);
      expect(m.body, m.name).toMatch(/@@(index|unique)\(\[orgId/);
    }
  });

  it('file_objects has NOT NULL org_id in SQL', () => {
    const fo = /CREATE TABLE "file_objects" \(([\s\S]*?)\);/.exec(allSql)?.[1] ?? '';
    expect(fo).toContain('"org_id" UUID NOT NULL');
  });

  it('every tenant CREATE TABLE declares org_id UUID NOT NULL', () => {
    for (const t of TENANT_TABLES) {
      const body = new RegExp(`CREATE TABLE "${t}" \\(([\\s\\S]*?)\\);`).exec(allSql)?.[1] ?? '';
      expect(body, t).toContain('"org_id" UUID NOT NULL');
    }
  });

  it('sessions store only a hashed token', () => {
    const s = models.find((m) => m.table === 'sessions')?.body ?? '';
    expect(s).toMatch(/tokenHash\s+String\s+@unique @map\("token_hash"\)/);
    expect(s).not.toMatch(/^\s+token\s/m);
    expect(allSql).not.toMatch(/"sessions"[\s\S]*?"token" TEXT/);
  });

  it('audit_events replaces audit_logs and is append-only for the app', () => {
    expect(schema).not.toContain('model AuditLog');
    expect(allSql).toContain('DROP TABLE "audit_logs"');
    expect(allSql).toContain('"audit_events_org_id_created_at_idx" ON "audit_events"("org_id", "created_at")');
    expect(rlsSql).toContain('REVOKE UPDATE, DELETE ON TABLE "audit_events" FROM meetops_app');
  });
});

describe('RLS migration', () => {
  it.each([...TENANT_TABLES])('%s has RLS enabled, forced, and a tenant policy', (t) => {
    expect(rlsSql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(
      `CREATE POLICY tenant_isolation ON "${t}"\n  USING (org_id = current_setting('app.current_org_id', true)::uuid)\n  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);`,
    );
  });

  it('does not enable RLS on global tables', () => {
    for (const t of GLOBAL_TABLES) expect(rlsSql).not.toContain(`ALTER TABLE "${t}" ENABLE`);
  });

  it('creates roles idempotently with NOBYPASSRLS for the app and DML-only grants', () => {
    expect(rlsSql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app'\)/);
    expect(rlsSql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'meetops_migrator'\)/);
    expect(rlsSql).toMatch(/CREATE ROLE meetops_app [^;]*NOBYPASSRLS/);
    expect(rlsSql).toContain('ALTER ROLE meetops_app NOSUPERUSER NOBYPASSRLS');
    expect(rlsSql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES');
    expect(rlsSql).toContain('OWNER TO meetops_migrator');
    expect(rlsSql).not.toMatch(/GRANT (ALL|TRUNCATE|CREATE)[^;]*TO meetops_app/);
    expect(rlsSql).not.toMatch(/PASSWORD\s+'/i);
  });

  it('schema uses a separate migrator URL', () => {
    expect(schema).toContain('directUrl  = env("MIGRATION_DATABASE_URL")');
  });
});

function mockClient() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve(1);
    }),
  };
  const client = {
    $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { client: client as unknown as TransactionCapableClient, calls, tx, raw: client };
}

describe('withOrgContext', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';

  it('sets app.current_org_id LOCAL inside one transaction before running fn', async () => {
    const m = mockClient();
    const order: string[] = [];
    m.tx.$executeRaw.mockImplementationOnce((s: TemplateStringsArray, ...v: unknown[]) => {
      order.push('set');
      m.calls.push({ sql: s.join('?'), values: v });
      return Promise.resolve(1);
    });
    const result = await withOrgContext(ORG, async () => {
      order.push('fn');
      return 42;
    }, { client: m.client });
    expect(result).toBe(42);
    expect(order).toEqual(['set', 'fn']);
    expect(m.raw.$transaction).toHaveBeenCalledTimes(1);
    expect(m.calls[0]?.sql).toContain('set_config(');
    expect(m.calls[0]?.values).toEqual([ORG_CONTEXT_SETTING, ORG]);
    expect(m.calls[0]?.sql).toMatch(/, true\)$/);
  });

  it('optionally sets app.current_user_id', async () => {
    const m = mockClient();
    await runWithOrgContext(m.client, ORG, async () => null, { userId: USER });
    expect(m.calls.map((c) => c.values)).toEqual([
      ['app.current_org_id', ORG],
      ['app.current_user_id', USER],
    ]);
  });

  it('passes the transaction client to fn', async () => {
    const m = mockClient();
    const seen = await withOrgContext(ORG, async (tx) => tx, { client: m.client });
    expect(seen).toBe(m.tx);
  });

  it('rejects non-uuid org ids without opening a transaction', async () => {
    const m = mockClient();
    await expect(withOrgContext("x' OR 1=1 --", async () => 1, { client: m.client })).rejects.toThrow(/UUID/);
    await expect(withOrgContext('', async () => 1, { client: m.client })).rejects.toThrow(TypeError);
    expect(m.raw.$transaction).not.toHaveBeenCalled();
  });

  it('propagates errors from fn (transaction rolls back)', async () => {
    const m = mockClient();
    await expect(
      withOrgContext(ORG, async () => {
        throw new Error('boom');
      }, { client: m.client }),
    ).rejects.toThrow('boom');
  });

  it('exports Prisma namespace alongside helpers', () => {
    expect(Prisma.ModelName.AuditEvent).toBe('AuditEvent');
  });
});
