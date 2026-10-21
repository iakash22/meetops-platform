import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { withOrgContext } from '../src/index.js';
import {
  TENANT_TABLES,
  ORG_CONTEXT_SETTING,
  runWithOrgContext,
  type TransactionCapableClient,
} from '../src/tenant.js';

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

  it('generated client has renamed models', () => {
    expect(Prisma.ModelName.AuditEvent).toBe('AuditEvent');
    expect(Prisma.ModelName.Task).toBe('Task');
  });
});

const hardeningSql = readFileSync(
  resolve(migrationsDir, '20261021100000_tenancy_hardening/migration.sql'),
  'utf8',
);

describe('cross-tenant referential integrity (M1)', () => {
  const tenantNames = new Set(tenantModels.map((m) => m.name));

  it('every tenant table has UNIQUE(org_id, id)', () => {
    for (const m of tenantModels) expect(m.body, m.name).toContain('@@unique([orgId, id])');
  });

  it('every relation between tenant tables is a composite (org_id, parent_id) FK', () => {
    let count = 0;
    for (const m of tenantModels) {
      for (const line of m.body.split('\n')) {
        const rel = /^\s+\w+\s+(\w+)\??(\[\])?\s+@relation\((.*)\)/.exec(line);
        if (!rel || rel[2] || !rel[3]?.includes('fields:')) continue;
        if (!tenantNames.has(rel[1] ?? '')) continue;
        expect(rel[3], `${m.name}: ${line.trim()}`).toMatch(/fields: \[orgId, \w+\], references: \[orgId, id\]/);
        expect(rel[3]).not.toContain('SetNull');
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it('migration creates composite FKs in SQL', () => {
    expect(hardeningSql).toContain(
      'FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id")',
    );
    expect(hardeningSql).toContain(
      'FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id")',
    );
  });
});

describe('per-org uniqueness (M2)', () => {
  it('storage key and external ids are unique per org', () => {
    expect(allSql).toContain('"file_objects"("org_id", "bucket", "storage_key")');
    expect(hardeningSql).toContain('DROP INDEX "file_objects_bucket_key_key"');
    expect(allSql).toContain('"integration_issues"("org_id", "integration", "external_id")');
    expect(allSql).toContain('"projects"("org_id", "key")');
  });

  it('only reviewed global uniques remain (email, slug, token hashes, storage key)', () => {
    const globals = [...schema.matchAll(/^[ \t]+(\w+)[ \t]+\S+[ \t][^\n]*@unique\b(?!\()/gm)].map((m) => m[1]).sort();
    expect(globals).toEqual(
      ['email', 'extractedTaskId', 'fileObjectId', 'key', 'slug', 'tokenHash', 'tokenHash'].sort(),
    );
  });
});

describe('sessions (M3) and audit retention (M4)', () => {
  it('sessions track last_seen_at, absolute expiry and FK active_org_id', () => {
    expect(allSql).toContain('"last_seen_at" TIMESTAMPTZ(3) NOT NULL');
    expect(allSql).toContain('"absolute_expires_at" TIMESTAMPTZ(3) NOT NULL');
    expect(allSql).toContain(
      'FOREIGN KEY ("active_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL',
    );
  });

  it('audit_events org FK is ON DELETE RESTRICT (no cascade with org)', () => {
    expect(allSql).toContain(
      '"audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT',
    );
  });
});

describe('storage objects and recordings', () => {
  it('file_objects is the single storage-object table with media fields and lineage', () => {
    const body = /CREATE TABLE "file_objects" \(([\s\S]*?)\);/.exec(allSql)?.[1] ?? '';
    const add = /ALTER TABLE "file_objects"[\s\S]*?;/g;
    const all = body + (hardeningSql.match(add) ?? []).join('\n');
    for (const c of [
      '"meeting_id" UUID', '"kind" "StorageObjectKind"', '"status" "StorageObjectStatus"', '"storage_key" TEXT',
      '"parent_object_id" UUID', '"etag"', '"duration_seconds"', '"sample_rate"', '"channels"',
      '"chunk_index"', '"start_seconds"', '"upload_id"', '"provider"',
    ]) expect(all, c).toContain(c);
    expect(allSql).toContain(`CREATE TYPE "StorageObjectKind" AS ENUM ('raw', 'normalized', 'chunk')`);
    expect(allSql).toContain(
      'FOREIGN KEY ("org_id", "parent_object_id") REFERENCES "file_objects"("org_id", "id")',
    );
    expect(schema).not.toContain('model MediaObject');
  });

  it('recordings reference a file object within the same org', () => {
    expect(allSql).toContain('CREATE TABLE "recordings"');
    expect(allSql).toContain(
      'FOREIGN KEY ("org_id", "file_object_id") REFERENCES "file_objects"("org_id", "id")',
    );
    expect(allSql).toContain(
      `CREATE TYPE "RecordingStatus" AS ENUM ('uploading', 'uploaded', 'processing', 'ready', 'failed')`,
    );
    expect(TENANT_TABLES).toContain('recordings');
  });

  it('contract names: tasks and integration_issues', () => {
    expect(TENANT_TABLES).toEqual(expect.arrayContaining(['tasks', 'integration_issues']));
    expect(allSql).toContain('CREATE TABLE "tasks"');
    expect(allSql).toContain('CREATE TABLE "integration_issues"');
  });

  it('enum labels are lowercase (contracts PR #17)', () => {
    const enums = [...schema.matchAll(/enum \w+ \{([\s\S]*?)\}/g)].flatMap((m) =>
      (m[1] ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    );
    for (const v of enums) expect(v).toMatch(/^[a-z][a-z_]*$/);
    expect(allSql).toContain(`'owner', 'admin', 'member', 'viewer'`);
  });
});

describe('storage key convention', () => {
  it('seed uses org/{orgId}/ prefix', () => {
    const seed = readFileSync(resolve(pkgDir, 'prisma/seed.ts'), 'utf8');
    expect(seed).toContain('`org/${org.id}/meetings/');
    expect(seed).not.toContain('orgs/');
  });
});

describe('XT-26..XT-28 static guarantees', () => {
  it('XT-26: policies use missing_ok current_setting so no context => NULL => 0 rows', () => {
    const policies = rlsSql.match(/current_setting\('app\.current_org_id', true\)::uuid/g) ?? [];
    expect(policies.length).toBe(TENANT_TABLES.length * 2);
    expect(rlsSql).not.toMatch(/current_setting\('app\.current_org_id'\)/);
  });

  it('XT-27: every tenant policy has WITH CHECK', () => {
    const n = (rlsSql.match(/CREATE POLICY tenant_isolation[^;]*WITH CHECK/g) ?? []).length;
    expect(n).toBe(TENANT_TABLES.length);
  });

  it('XT-28: org context is transaction-local (set_config is_local=true), never session SET', () => {
    const src = readFileSync(resolve(pkgDir, 'src/tenant.ts'), 'utf8');
    expect(src).toMatch(/set_config\(\$\{ORG_CONTEXT_SETTING\}, \$\{orgId\}, true\)/);
    expect(src).not.toMatch(/\bSET\s+app\./i);
  });
});
