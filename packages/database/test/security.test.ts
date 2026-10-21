import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { withOrgContext, withUserContext } from '../src/index.js';
import {
  TENANT_TABLES,
  ORG_CONTEXT_SETTING,
  runWithOrgContext,
  type TransactionCapableClient,
} from '../src/tenant.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(resolve(pkgDir, 'prisma/schema.prisma'), 'utf8');
const migrationsDir = resolve(pkgDir, 'prisma/migrations');
/** DDL of the final schema (what the migration chain must converge to; the live drift check proves it). */
const finalSql = execFileSync(
  'pnpm',
  [
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ],
  {
    cwd: pkgDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db',
      MIGRATION_DATABASE_URL:
        process.env.MIGRATION_DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db',
    },
  },
);
const migrationSql = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((d) => readFileSync(resolve(migrationsDir, d, 'migration.sql'), 'utf8'))
  .join('\n');
const allSql = `${finalSql}\n${migrationSql}`;
/** Tables added after the RLS migration enable and police RLS in their own migration. */
const laterTenantSql = readFileSync(resolve(migrationsDir, '20261021180000_recording_sessions/migration.sql'), 'utf8');
const rlsSql =
  readFileSync(resolve(migrationsDir, '20261021110000_tenant_rls_roles/migration.sql'), 'utf8') + laterTenantSql;
/** Latest (effective) tenant policy definitions. */
const policySql =
  readFileSync(resolve(migrationsDir, '20261021130000_rls_fail_closed_empty_setting/migration.sql'), 'utf8') +
  laterTenantSql;
const ORG_EXPR = "NULLIF(current_setting('app.current_org_id', true), '')::uuid";

/** Parse models from schema: table name + body. */
const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)].map((m) => {
  const body = m[2] ?? '';
  return { name: m[1] ?? '', table: /@@map\("(\w+)"\)/.exec(body)?.[1] ?? '', body };
});
const tenantModels = models.filter((m) => /^\s+organizationId\s/m.test(m.body));
const GLOBAL_TABLES = [
  'organizations',
  'users',
  'sessions',
  'email_verifications',
  'password_resets',
];
/** Tenant tables whose org_id may be NULL (global auth audit events). */
const NULLABLE_ORG = ['audit_events'];

describe('tenant schema', () => {
  it('every table is either a tenant table or an explicitly reviewed global table', () => {
    const tenant = tenantModels.map((m) => m.table).sort();
    expect(tenant).toEqual([...TENANT_TABLES].sort());
    const others = models.map((m) => m.table).filter((t) => !tenant.includes(t));
    expect(others.sort()).toEqual([...GLOBAL_TABLES].sort());
  });

  it('org_id is required (NOT NULL) with an org FK on every tenant table', () => {
    for (const m of tenantModels) {
      if (NULLABLE_ORG.includes(m.table)) continue;
      expect(m.body, m.name).toMatch(/^\s+organizationId\s+String\s+@map\("org_id"\)/m);
      expect(m.body, m.name).toMatch(/organization\s+Organization\s+@relation\(fields: \[organizationId\]/);
      expect(m.body, m.name).toMatch(/@@(index|unique)\(\[organizationId/);
    }
  });

  it('file_objects has NOT NULL org_id in SQL', () => {
    const fo = /CREATE TABLE "file_objects" \(([\s\S]*?)\);/.exec(allSql)?.[1] ?? '';
    expect(fo).toContain('"org_id" UUID NOT NULL');
  });

  it('every tenant CREATE TABLE declares org_id UUID NOT NULL', () => {
    for (const t of TENANT_TABLES) {
      if (NULLABLE_ORG.includes(t)) continue;
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
    expect(hardeningSql).toContain('ALTER TABLE "audit_logs" RENAME TO "audit_events";');
    expect(allSql).toContain(
      '"audit_events_org_id_created_at_idx" ON "audit_events"("org_id", "created_at")',
    );
    expect(rlsSql).toContain('REVOKE UPDATE, DELETE ON TABLE "audit_events" FROM meetops_app');
  });
});

describe('RLS migration', () => {
  it.each([...TENANT_TABLES])('%s has RLS enabled, forced, and a tenant policy', (t) => {
    expect(rlsSql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(`CREATE POLICY tenant_isolation ON "${t}"`);
    expect(policySql).toContain(
      `CREATE POLICY tenant_isolation ON "${t}"\n  USING (org_id = ${ORG_EXPR})\n  WITH CHECK (org_id = ${ORG_EXPR});`,
    );
  });

  it('does not enable RLS on global tables', () => {
    for (const t of GLOBAL_TABLES) expect(rlsSql).not.toContain(`ALTER TABLE "${t}" ENABLE`);
  });

  it('creates roles idempotently with NOBYPASSRLS for the app and DML-only grants', () => {
    expect(rlsSql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'meetops_app'\)/,
    );
    expect(rlsSql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'meetops_migrator'\)/,
    );
    expect(rlsSql).toMatch(/CREATE ROLE meetops_app [^;]*NOBYPASSRLS/);
    expect(rlsSql).toContain(
      "RAISE EXCEPTION 'meetops_app must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB'",
    );
    expect(rlsSql).not.toMatch(/ALTER ROLE/);
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
    const result = await withOrgContext(
      ORG,
      async () => {
        order.push('fn');
        return 42;
      },
      { client: m.client },
    );
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
    await expect(
      withOrgContext("x' OR 1=1 --", async () => 1, { client: m.client }),
    ).rejects.toThrow(/UUID/);
    await expect(withOrgContext('', async () => 1, { client: m.client })).rejects.toThrow(
      TypeError,
    );
    expect(m.raw.$transaction).not.toHaveBeenCalled();
  });

  it('propagates errors from fn (transaction rolls back)', async () => {
    const m = mockClient();
    await expect(
      withOrgContext(
        ORG,
        async () => {
          throw new Error('boom');
        },
        { client: m.client },
      ),
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
    for (const m of tenantModels) expect(m.body, m.name).toContain('@@unique([organizationId, id])');
  });

  it('every relation between tenant tables is a composite (org_id, parent_id) FK', () => {
    let count = 0;
    for (const m of tenantModels) {
      for (const line of m.body.split('\n')) {
        const rel = /^\s+\w+\s+(\w+)\??(\[\])?\s+@relation\((.*)\)/.exec(line);
        if (!rel || rel[2] || !rel[3]?.includes('fields:')) continue;
        if (!tenantNames.has(rel[1] ?? '')) continue;
        expect(rel[3], `${m.name}: ${line.trim()}`).toMatch(
          /fields: \[organizationId, \w+\], references: \[organizationId, id\]/,
        );
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
    expect(finalSql).toContain('"integration_issues"("org_id", "provider", "external_id")');
    expect(allSql).toContain('"projects"("org_id", "key")');
  });

  it('only reviewed global uniques remain (email, slug, token hashes, storage key)', () => {
    const globals = [...schema.matchAll(/^[ \t]+(\w+)[ \t]+\S+[ \t][^\n]*@unique\b(?!\()/gm)]
      .map((m) => m[1])
      .sort();
    expect(globals).toEqual(
      [
        'email',
        'extractedTaskId',
        'fileObjectId',
        'key',
        'recordingId',
        'slug',
        'storageKey',
        'tokenHash',
        'tokenHash',
        'tokenHash',
        'tokenHash',
      ].sort(),
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
      '"meeting_id" UUID',
      '"kind" "StorageObjectKind"',
      '"status" "StorageObjectStatus"',
      '"storage_key" TEXT',
      '"parent_object_id" UUID',
      '"etag"',
      '"duration_seconds"',
      '"sample_rate"',
      '"channels"',
      '"chunk_index"',
      '"start_seconds"',
      '"upload_id"',
      '"provider"',
    ])
      expect(all, c).toContain(c);
    expect(allSql).toContain(
      `CREATE TYPE "StorageObjectKind" AS ENUM ('raw', 'normalized', 'chunk')`,
    );
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
      (m[1] ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    for (const v of enums) expect(v).toMatch(/^[a-z][a-z_]*$/);
    expect(allSql).toContain(`'owner', 'admin', 'member', 'viewer'`);
  });
});

describe('storage key convention', () => {
  it('seed uses org/{organizationId}/ prefix', () => {
    const seed = readFileSync(resolve(pkgDir, 'prisma/seed.ts'), 'utf8');
    expect(seed).toContain('`org/${org.id}/meetings/');
    expect(seed).not.toContain('orgs/');
  });
});

describe('XT-26..XT-28 static guarantees', () => {
  it('XT-26: policies use missing_ok current_setting so no context => NULL => 0 rows', () => {
    const policies = policySql.split(ORG_EXPR).length - 1;
    expect(policies).toBe(TENANT_TABLES.length * 2);
    expect(policySql).not.toMatch(/current_setting\('app\.current_org_id'\)/);
  });

  it('XT-27: every tenant policy has WITH CHECK', () => {
    const n = (policySql.match(/CREATE POLICY tenant_isolation[^;]*WITH CHECK/g) ?? []).length;
    expect(n).toBe(TENANT_TABLES.length);
  });

  it('XT-28: org context is transaction-local (set_config is_local=true), never session SET', () => {
    const src = readFileSync(resolve(pkgDir, 'src/tenant.ts'), 'utf8');
    expect(src).toMatch(/set_config\(\$\{ORG_CONTEXT_SETTING\}, \$\{organizationId\}, true\)/);
    expect(src).not.toMatch(/\bSET\s+app\./i);
  });
});

const defSql = readFileSync(
  resolve(migrationsDir, '20261021120000_invitation_lookup_outbox_relay/migration.sql'),
  'utf8',
);

describe('invitation definer functions', () => {
  for (const fn of ['lookup_invitation_by_token_hash(text)', 'accept_invitation(text, uuid)']) {
    it(`${fn} is locked down`, () => {
      expect(defSql).toContain(`ALTER FUNCTION ${fn} OWNER TO meetops_migrator;`);
      expect(defSql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(defSql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO meetops_app;`);
      expect(
        defSql.match(
          new RegExp(`GRANT EXECUTE ON FUNCTION ${fn.replace(/[()]/g, '\\$&')} TO`, 'g'),
        ),
      ).toHaveLength(1);
    });
  }

  it('both are SECURITY DEFINER with a fixed search_path', () => {
    expect(defSql.match(/SECURITY DEFINER\nSET search_path = public, pg_temp/g)).toHaveLength(2);
  });

  it('lookup matches by token hash only and returns minimal fields', () => {
    const body = /FUNCTION lookup_invitation_by_token_hash[\s\S]*?\$\$;/.exec(defSql)?.[0] ?? '';
    expect(body).toContain('WHERE i.token_hash = p_token_hash');
    expect(body).toMatch(/SELECT i\.id, i\.org_id, i\.email, i\.role, i\.status, i\.expires_at\n/);
    expect(body).not.toMatch(/token_hash,|\*/);
  });

  it('accept checks status, expiry and email, and audits', () => {
    const body = /FUNCTION accept_invitation[\s\S]*?\$\$;/.exec(defSql)?.[0] ?? '';
    expect(body).toContain("inv.status <> 'pending'");
    expect(body).toContain('inv.expires_at <= now()');
    expect(body).toContain('lower(u_email) <> lower(inv.email)');
    expect(body).toContain("'invitation.accepted'");
  });
});

describe('outbox relay role', () => {
  it('meetops_relay gets only SELECT + delivery-column UPDATE on outbox_events', () => {
    const grants = defSql.match(/GRANT [^;]* TO meetops_relay;/g) ?? [];
    expect(defSql).toContain('GRANT USAGE ON SCHEMA %I TO meetops_relay');
    expect(grants).toEqual([
      'GRANT SELECT ON TABLE "outbox_events" TO meetops_relay;',
      expect.stringMatching(
        /^GRANT UPDATE \("status", "attempts", "last_error", "available_at", "published_at", "updated_at"\)\s+ON TABLE "outbox_events" TO meetops_relay;$/,
      ),
    ]);
    expect(defSql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM meetops_relay');
    expect(allSql).not.toMatch(/DEFAULT PRIVILEGES[^;]*meetops_relay/);
  });
});

describe('schema conventions', () => {
  it('every multi-word scalar field has an explicit @map', () => {
    const enumNames = new Set([...schema.matchAll(/^enum (\w+)/gm)].map((m) => m[1]));
    const scalars = new Set([
      'String',
      'Int',
      'BigInt',
      'Float',
      'Decimal',
      'Boolean',
      'DateTime',
      'Json',
      'Bytes',
    ]);
    const missing: string[] = [];
    for (const m of models) {
      for (const line of m.body.split('\n')) {
        const f = /^\s+(\w+)\s+(\w+|Unsupported\("[^"]*"\))/.exec(line);
        if (!f?.[1] || !f[2]) continue;
        const isScalar = scalars.has(f[2]) || enumNames.has(f[2]) || f[2].startsWith('Unsupported');
        if (isScalar && /[A-Z]/.test(f[1]) && !line.includes('@map('))
          missing.push(`${m.name}.${f[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every model uses a uuid primary key', () => {
    expect(models).toHaveLength(25);
    for (const m of models)
      expect(m.body, m.name).toMatch(/^\s+id\s+String\s+@id @default\(uuid\(\)\) @db\.Uuid$/m);
  });

  it('transcripts carry provider + provider_job_id unique per org', () => {
    expect(allSql).toContain('"transcripts"("org_id", "provider", "provider_job_id")');
  });
});

describe('contracts v0.2 (PR #38) alignment', () => {
  const v02 = readFileSync(
    resolve(migrationsDir, '20261021150000_contracts_v02_alignment/migration.sql'),
    'utf8',
  );
  it('MeetingParticipantRole is exactly host|participant, mapped without data loss', () => {
    expect(/enum MeetingParticipantRole \{\s*host\s+participant\s*\}/.test(schema)).toBe(true);
    expect(v02).toContain(`WHEN 'host' THEN 'host' ELSE 'participant'`);
  });
  it('participants have nullable user_id, joined_at, left_at; extracted tasks have hints', () => {
    for (const c of [
      '"user_id" UUID',
      '"joined_at" TIMESTAMPTZ(3)',
      '"left_at" TIMESTAMPTZ(3)',
      '"assignee_hint" TEXT',
      '"due_hint" TEXT',
    ]) {
      expect(v02).toContain(c);
    }
  });
  it('ai_run_id and created_by_id are nullable where the contract allows null', () => {
    for (const [model, field] of [
      ['Report', 'aiRunId'],
      ['ExtractedTask', 'aiRunId'],
      ['Meeting', 'createdById'],
      ['Task', 'createdById'],
    ] as const) {
      const body = models.find((m) => m.name === model)?.body ?? '';
      expect(body, `${model}.${field}`).toMatch(new RegExp(`^\\s+${field}\\s+String\\?`, 'm'));
    }
  });
});

describe('data-preserving migrations', () => {
  it('no migration drops a table; renames are in place', () => {
    expect(migrationSql).not.toMatch(/DROP TABLE/);
    for (const r of [
      'ALTER TABLE "internal_tasks" RENAME TO "tasks";',
      'ALTER TABLE "external_issue_links" RENAME TO "integration_issues";',
      'ALTER TABLE "file_objects" RENAME COLUMN "key" TO "storage_key";',
      `ALTER TYPE "MembershipRole" RENAME VALUE 'OWNER' TO 'owner';`,
    ])
      expect(hardeningSql).toContain(r);
  });
});

const authSql = readFileSync(
  resolve(migrationsDir, '20261021160000_auth_tables_audit_global/migration.sql'),
  'utf8',
);

describe('backend feedback (auth tables, global audit, invitation/org metadata)', () => {
  it('email_verifications and password_resets: global, hashed token unique, app DML, no RLS', () => {
    for (const t of ['email_verifications', 'password_resets']) {
      expect(finalSql).toContain(
        `CREATE UNIQUE INDEX "${t}_token_hash_key" ON "${t}"("token_hash")`,
      );
      expect(allSql).not.toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    }
    expect(authSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "email_verifications", "password_resets" TO meetops_app;',
    );
  });

  it('audit_events: nullable org_id, org-scoped read, insert-only for NULL org', () => {
    expect(authSql).toContain('ALTER TABLE "audit_events" ALTER COLUMN "org_id" DROP NOT NULL;');
    expect(authSql).toContain('DROP POLICY IF EXISTS tenant_isolation ON "audit_events";');
    expect(authSql).toMatch(
      /CREATE POLICY audit_read_own_org ON "audit_events" FOR SELECT\n\s+USING \(org_id = NULLIF/,
    );
    expect(authSql).toMatch(
      /CREATE POLICY audit_insert ON "audit_events" FOR INSERT\n\s+WITH CHECK \(org_id IS NULL OR org_id = NULLIF/,
    );
    expect(finalSql).toContain(
      '"audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT',
    );
  });

  it('invitations: accepted_by_id, revoked_at, deleted_at; organizations.created_by_id', () => {
    for (const c of [
      '"accepted_by_id" UUID',
      '"revoked_at" TIMESTAMPTZ(3)',
      '"deleted_at" TIMESTAMPTZ(3)',
    ]) {
      expect(authSql).toContain(c);
    }
    expect(authSql).toContain('ALTER TABLE "organizations" ADD COLUMN     "created_by_id" UUID;');
    expect(authSql).toContain('accepted_by_id = p_user_id');
  });
});

describe('withUserContext', () => {
  it('sets only app.current_user_id, LOCAL, and validates uuid', async () => {
    const m = mockClient();
    const USER = '33333333-3333-4333-8333-333333333333';
    await withUserContext(USER, async () => 1, { client: m.client });
    expect(m.calls.map((c) => c.values)).toEqual([['app.current_user_id', USER]]);
    expect(m.calls[0]?.sql).toMatch(/, true\)$/);
    await expect(withUserContext('nope', async () => 1, { client: m.client })).rejects.toThrow(
      /UUID/,
    );
  });

  it('membership self-read policy keys on app.current_user_id', () => {
    expect(policySql).toContain(
      `USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)`,
    );
  });
});

const headSql = readFileSync(
  resolve(migrationsDir, '20261021170000_integration_provider_grants/migration.sql'),
  'utf8',
);

describe('contracts #38 integration_issues + DevOps #7 role compatibility', () => {
  it('integration_issues has integration_id, provider and unique (org_id, provider, external_id)', () => {
    expect(finalSql).toMatch(/"integration_id" UUID,/);
    expect(finalSql).toMatch(/"provider" TEXT NOT NULL,/);
    expect(headSql).toContain(
      'CREATE UNIQUE INDEX "integration_issues_org_id_provider_external_id_key"',
    );
  });

  it('head migration re-asserts app grants, default privileges and FORCE RLS; audit stays append-only', () => {
    for (const g of [
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO meetops_app',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO meetops_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meetops_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE meetops_migrator IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO meetops_app',
      'FORCE ROW LEVEL SECURITY',
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_events" FROM meetops_app;',
    ])
      expect(headSql).toContain(g);
    // Roles are only created when missing and never altered, so pre-existing infra roles are kept.
    expect(migrationSql).not.toMatch(/ALTER ROLE/);
  });
});

const sessionSql = readFileSync(
  resolve(migrationsDir, '20261021180000_recording_sessions/migration.sql'),
  'utf8',
);

describe('recording sessions (contracts v0.2)', () => {
  it('are tenant tables with forced RLS and composite tenant FKs', () => {
    for (const t of ['recording_sessions', 'recording_session_chunks']) {
      expect(TENANT_TABLES).toContain(t);
      expect(sessionSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
      expect(sessionSql).toContain(`CREATE POLICY tenant_isolation ON "${t}"`);
    }
    expect(finalSql).toContain(
      'FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id") ON DELETE CASCADE',
    );
    expect(finalSql).toContain(
      '"recording_sessions_org_id_recording_id_fkey" FOREIGN KEY ("org_id", "recording_id") REFERENCES "recordings"("org_id", "id") ON DELETE RESTRICT',
    );
    expect(finalSql).toContain(
      '"recording_session_chunks_org_id_session_id_fkey" FOREIGN KEY ("org_id", "session_id") REFERENCES "recording_sessions"("org_id", "id") ON DELETE CASCADE',
    );
  });

  it('enums and limits match the contract', () => {
    expect(finalSql).toContain(`CREATE TYPE "RecordingSource" AS ENUM ('tab');`);
    expect(finalSql).toContain(
      `CREATE TYPE "RecordingAbortReason" AS ENUM ('user_stopped', 'consent_revoked', 'tab_closed', 'local_storage_exhausted', 'error');`,
    );
    expect(finalSql).toContain(`CREATE UNIQUE INDEX "recording_session_chunks_session_id_seq_key"`);
    for (const c of [
      'BETWEEN 1 AND 10000',
      'BETWEEN 0 AND 2000000000',
      'BETWEEN 0 AND 9999',
      'BETWEEN 1 AND 67108864',
    ]) {
      expect(sessionSql).toContain(c);
    }
  });
});

describe('worker UUIDv5 media ids (PR #39)', () => {
  it('reproduces the RFC 4122 v5 test vector', async () => {
    const { uuidV5 } = await import('./media-ids.js');
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('file_objects.id has no DB default, so caller-supplied ids are stored as given', () => {
    const fo = /CREATE TABLE "file_objects" \(([\s\S]*?)\n\);/.exec(finalSql)?.[1] ?? '';
    expect(fo).toMatch(/"id" UUID NOT NULL,/);
    expect(fo).not.toMatch(/"id" UUID NOT NULL DEFAULT/);
    // chunk uniqueness is per parent, so v5 chunk ids under a normalized parent never collide with raw/normalized rows
    expect(finalSql).toContain(
      'CREATE UNIQUE INDEX "file_objects_parent_object_id_chunk_index_key"',
    );
  });
});

const addendum2Sql = readFileSync(resolve(migrationsDir, '20261022000000_adr004_addendum2/migration.sql'), 'utf8');

describe('ADR-004 addendum 2 (contracts 0.3.0)', () => {
  it('(a) Prisma exposes organizationId mapped to org_id, never orgId', () => {
    expect(schema).not.toMatch(/\borgId\b/);
    const fields = [...schema.matchAll(/^\s+organizationId\s+String\??\s+@map\("(\w+)"\)/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    expect(new Set(fields)).toEqual(new Set(['org_id']));
    const src = readFileSync(resolve(pkgDir, 'src/tenant.ts'), 'utf8') + readFileSync(resolve(pkgDir, 'src/index.ts'), 'utf8');
    expect(src).not.toMatch(/\borgId\b/);
    expect(src).toContain("'app.current_org_id'");
  });

  it('(b) extracted_tasks.report_id NOT NULL with a backfill that fails clearly, RLS re-forced', () => {
    expect(finalSql).toMatch(/CREATE TABLE "extracted_tasks" \([\s\S]*?"report_id" UUID NOT NULL,/);
    expect(addendum2Sql).toContain('RAISE EXCEPTION \'ADR-004 addendum 2 (b)');
    expect(addendum2Sql).toContain('ALTER TABLE "extracted_tasks" FORCE ROW LEVEL SECURITY;');
  });

  it('(c) transcripts.provider NOT NULL, legacy rows become unknown', () => {
    expect(finalSql).toMatch(/CREATE TABLE "transcripts" \([\s\S]*?"provider" TEXT NOT NULL,/);
    expect(addendum2Sql).toContain(`UPDATE "transcripts" SET "provider" = 'unknown' WHERE "provider" IS NULL;`);
    expect(addendum2Sql).toContain('ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;');
  });

  it('(d) meeting_participants has no employee_id; (e) only tasks.extracted_task_id links tasks', () => {
    const mp = /CREATE TABLE "meeting_participants" \(([\s\S]*?)\n\);/.exec(finalSql)?.[1] ?? '';
    expect(mp).not.toContain('employee_id');
    expect(finalSql).not.toMatch(/accepted_task_id/);
    const et = /CREATE TABLE "extracted_tasks" \(([\s\S]*?)\n\);/.exec(finalSql)?.[1] ?? '';
    expect(et).not.toMatch(/"task_id"/);
    expect(finalSql).toContain('CREATE UNIQUE INDEX "tasks_extracted_task_id_key" ON "tasks"("extracted_task_id");');
  });
});

describe('DB-BUG-2: every setting-based policy is NULLIF-guarded', () => {
  it('the latest definition of each policy reads settings only through NULLIF(..., \'\')::uuid', () => {
    const latest = new Map<string, string>();
    for (const m of migrationSql.matchAll(/CREATE POLICY (\w+) ON "(\w+)"([\s\S]*?);/g)) {
      latest.set(`${m[2]}.${m[1]}`, m[3] ?? '');
    }
    const withSetting = [...latest].filter(([, body]) => body.includes('current_setting'));
    expect(withSetting.length).toBeGreaterThanOrEqual(TENANT_TABLES.length + 1);
    for (const [name, body] of withSetting) {
      const raw = body.match(/current_setting\('app\.current_(org|user)_id', true\)/g) ?? [];
      const guarded = body.match(/NULLIF\(current_setting\('app\.current_(org|user)_id', true\), ''\)::uuid/g) ?? [];
      expect(guarded.length, name).toBe(raw.length);
    }
  });
});
