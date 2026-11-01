import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { withOrgContext, withOrganizationContext, withUserContext } from '../src/index.js';
import {
  TENANT_TABLES,
  ORG_CONTEXT_SETTING,
  ORGANIZATION_CONTEXT_SETTING,
  LEGACY_ORG_CONTEXT_SETTING,
  runWithOrgContext,
  runWithOrganizationContext,
  type TransactionCapableClient,
} from '../src/tenant.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Call the local Prisma CLI via node (Windows: `execFileSync('pnpm')` is ENOENT for pnpm.cmd). */
const prismaCli = resolve(pkgDir, 'node_modules/prisma/build/index.js');
const schema = readFileSync(resolve(pkgDir, 'prisma/schema.prisma'), 'utf8');
const migrationsDir = resolve(pkgDir, 'prisma/migrations');
/** DDL of the final schema (what the migration chain must converge to; the live drift check proves it). */
const finalSql = execFileSync(
  process.execPath,
  [
    prismaCli,
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
const laterTenantSql = readFileSync(
  resolve(migrationsDir, '20261021180000_recording_sessions/migration.sql'),
  'utf8',
);
/** AI usage / chunked transcripts (item 7): new tenant tables enable and police RLS in their own migration. */
const aiTenantSql = readFileSync(
  resolve(migrationsDir, '20261024010000_ai_usage_transcript_chunks/migration.sql'),
  'utf8',
);
/** DB-1 teams: new tenant tables enable and police RLS in their own migration (ADR-010 setting only). */
const teamsSql = readFileSync(resolve(migrationsDir, '20261025090000_teams/migration.sql'), 'utf8');
/** ADR-005 durable token families: ADR-010-only tenant tables with their own policies. */
const AUTH_TOKENS_MIGRATION = '20261026230000_auth_token_families';
const authTokensSql = readFileSync(
  resolve(migrationsDir, AUTH_TOKENS_MIGRATION, 'migration.sql'),
  'utf8',
);
/** Every migration that creates ADR-010-only tenant policies. */
const CONSENT_MIGRATION = '20261025120000_consent_scan_keycheck';
const MEETINGS_EXTERNAL_ID_MIGRATION = '20261026120000_meetings_external_id';
const RECORDING_SOURCE_NATIVE_MIGRATION = '20261026210000_recording_source_native';
/** Update when adding a migration. */
const INTEGRATION_CONNECTIONS_MIGRATION = '20261027000000_integration_connections';
const INTEGRATION_ROUTING_MIGRATION = '20261027100000_integration_routing_functions';
/** Phase 3 AI summary dedupe (reports unique key). Update LATEST_MIGRATION when adding a migration. */
const REPORT_SUMMARY_DEDUPE_MIGRATION = '20261027120000_report_summary_dedupe';
/** P1-DB-4 recording bytes_received + add_recording_session_bytes(). */
const RECORDING_BYTES_MIGRATION = '20261027130000_recording_session_bytes_received';
/** Definer SELECT policy for the integration routing functions (forced RLS binds the owner). */
const INTEGRATION_ROUTING_POLICY_MIGRATION = '20261027140000_integration_routing_definer_policy';
/** ADR-014 session/audit geo columns + 30-day IP retention. */
const SESSION_AUDIT_GEOIP_MIGRATION = '20261028010000_session_audit_geoip';
/** ADR-013 notifications tables. Update LATEST_MIGRATION when adding a migration. */
const NOTIFICATIONS_MIGRATION = '20261027180000_notifications';
const RELAY_BY_TYPE_MIGRATION = '20261028000000_relay_claim_by_event_type';
const RELAY_REVOKE_ALL_KINDS_MIGRATION = '20261028030000_relay_revoke_claim_all_kinds';
const notificationsSql = readFileSync(
  resolve(migrationsDir, NOTIFICATIONS_MIGRATION, 'migration.sql'),
  'utf8',
);
const NOTIFICATION_TABLES = [
  'notifications',
  'notification_delivery_attempts',
  'notification_preferences',
  'push_device_tokens',
] as const;
/** App-wide GitHub webhook routing by installation id (definer function, identifiers only). */
const EXTERNAL_ACCOUNT_ROUTING_MIGRATION = '20261028020000_integration_external_account_routing';
/** #288 L-1 remainder: re-assert migrator ownership + column grants of the IP retention tables. */
const RETENTION_OWNER_MIGRATION = '20261028040000_geoip_retention_owner_assert';
/** Phase 7 calendar_connections (forced RLS, envelope-only tokens). */
const CALENDAR_CONNECTIONS_MIGRATION = '20261031000000_calendar_connections';
/** Phase 7 meeting search: FTS expression GIN indexes only. */
const MEETING_SEARCH_MIGRATION = '20261031010000_meeting_search_fts';
/** Phase 7 calendar background sync (calendar_events + sync cursor + due-for-sync definer function). */
const CALENDAR_EVENTS_MIGRATION = '20261031020000_calendar_events';
/** Phase 7 semantic search: meeting_embeddings (pgvector, forced RLS, no ANN index). */
const MEETING_EMBEDDINGS_MIGRATION = '20261031050000_meeting_embeddings';
/** MeetingSource gains 'mobile' (additive ADD VALUE). Sorts after meeting_embeddings. */
const MEETING_SOURCE_MOBILE_MIGRATION = '20261031120000_meeting_source_mobile';
const LATEST_MIGRATION = MEETING_SOURCE_MOBILE_MIGRATION;
/**
 * Parallel PRs that sort between calendar_events and meeting_embeddings (#334 consent events, #341 calendar links).
 * The order checks below ignore them so they hold whichever merges first; when present they must sort before ours.
 */
const PARALLEL_MIGRATIONS = [
  '20261031030000_meeting_consent_events',
  '20261031040000_calendar_event_links',
] as const;
const orderedDirs = () => {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort();
  for (const p of PARALLEL_MIGRATIONS)
    if (dirs.includes(p))
      expect(dirs.indexOf(p)).toBeLessThan(dirs.indexOf(MEETING_EMBEDDINGS_MIGRATION));
  return dirs.filter((d) => !(PARALLEL_MIGRATIONS as readonly string[]).includes(d));
};
const reportDedupeSql = readFileSync(
  resolve(migrationsDir, REPORT_SUMMARY_DEDUPE_MIGRATION, 'migration.sql'),
  'utf8',
);
const integrationsSql = readFileSync(
  resolve(migrationsDir, INTEGRATION_CONNECTIONS_MIGRATION, 'migration.sql'),
  'utf8',
);
/** Migrations whose tenant policies use only the ADR-010 setting. */
const calendarSql = readFileSync(
  resolve(migrationsDir, CALENDAR_CONNECTIONS_MIGRATION, 'migration.sql'),
  'utf8',
);
const calendarEventsSql = readFileSync(
  resolve(migrationsDir, CALENDAR_EVENTS_MIGRATION, 'migration.sql'),
  'utf8',
);
const meetingEmbeddingsSql = readFileSync(
  resolve(migrationsDir, MEETING_EMBEDDINGS_MIGRATION, 'migration.sql'),
  'utf8',
);
const adr010Sql =
  teamsSql +
  authTokensSql +
  integrationsSql +
  notificationsSql +
  calendarSql +
  calendarEventsSql +
  meetingEmbeddingsSql;
/** Phase 3 per-recording transcript revision migration. */
const TRANSCRIPT_REVISION_MIGRATION_DIR = '20261026200000_transcript_recording_revision';
const consentSql = readFileSync(resolve(migrationsDir, CONSENT_MIGRATION, 'migration.sql'), 'utf8');
const rlsSql =
  readFileSync(resolve(migrationsDir, '20261021110000_tenant_rls_roles/migration.sql'), 'utf8') +
  laterTenantSql +
  aiTenantSql +
  adr010Sql;
/**
 * Tenant tables keyed by the organization itself rather than a uuid id: ai_org_config (PK org_id) and
 * ai_idempotency (PK (org_id, key)). Their primary key already leads with org_id.
 */
const ORGANIZATION_KEYED = ['ai_org_config', 'ai_idempotency'];
/** Pre-ADR-010 tenant policy definitions (still the source of membership_self_read). */
const legacyPolicySql =
  readFileSync(
    resolve(migrationsDir, '20261021130000_rls_fail_closed_empty_setting/migration.sql'),
    'utf8',
  ) + laterTenantSql;
/** Latest (effective) tenant policy definitions: ADR-010 organization context setting. */
const policySql =
  readFileSync(
    resolve(migrationsDir, '20261024000000_organization_context_setting/migration.sql'),
    'utf8',
  ) + aiTenantSql;
const ORG_EXPR =
  "COALESCE(NULLIF(current_setting('app.current_organization_id', true), ''), NULLIF(current_setting('app.current_org_id', true), ''))::uuid";
/** Policy expression for tenant tables created after ADR-010: canonical setting only, no legacy COALESCE. */
const ADR010_EXPR = "NULLIF(current_setting('app.current_organization_id', true), '')::uuid";
/** Tenant tables whose policies never had the legacy fallback (DB-1 and later). */
const ADR010_ONLY_TABLES: readonly string[] = [
  'teams',
  'team_members',
  'auth_devices',
  'auth_token_families',
  'auth_refresh_tokens',
  'integration_connections',
  ...NOTIFICATION_TABLES,
  'calendar_connections',
  'calendar_events',
  'meeting_embeddings',
];
/** DB-3: append-only tenant tables with their own SELECT/INSERT policies (ADR-010 setting) in consentSql. */
const CONSENT_TABLES: readonly string[] = ['consent_attestations'];

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
      expect(m.body, m.name).toMatch(/^\s+organizationId\s+String\s+(@id\s+)?@map\("org_id"\)/m);
      expect(m.body, m.name).toMatch(
        /organization\s+Organization\s+@relation\(fields: \[organizationId\]/,
      );
      expect(m.body, m.name).toMatch(
        /@@(index|unique|id)\(\[organizationId|organizationId\s+String\s+@id/,
      );
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
    if (CONSENT_TABLES.includes(t)) {
      expect(consentSql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(consentSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
      expect(consentSql).toContain(
        `CREATE POLICY consent_select ON "${t}" FOR SELECT\n  USING (org_id = ${ADR010_EXPR});`,
      );
      expect(consentSql).toContain(
        `CREATE POLICY consent_insert ON "${t}" FOR INSERT\n  WITH CHECK (org_id = ${ADR010_EXPR});`,
      );
      return;
    }
    expect(rlsSql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
    expect(rlsSql).toContain(`CREATE POLICY tenant_isolation ON "${t}"`);
    if (t === 'audit_events') {
      expect(policySql).toContain(
        `CREATE POLICY audit_read_own_org ON "audit_events" FOR SELECT\n  USING (org_id = ${ORG_EXPR});`,
      );
      expect(policySql).toContain(
        `CREATE POLICY audit_insert ON "audit_events" FOR INSERT\n  WITH CHECK (org_id = ${ORG_EXPR});`,
      );
      return;
    }
    if (ADR010_ONLY_TABLES.includes(t)) {
      expect(adr010Sql).toContain(
        `CREATE POLICY tenant_isolation ON "${t}"\n  USING (org_id = ${ADR010_EXPR})\n  WITH CHECK (org_id = ${ADR010_EXPR});`,
      );
      return;
    }
    expect(policySql).toContain(
      `CREATE POLICY tenant_isolation ON "${t}"\n  USING (org_id = ${ORG_EXPR})\n  WITH CHECK (org_id = ${ORG_EXPR});`,
    );
  });

  it('does not enable RLS on global tables', () => {
    for (const t of GLOBAL_TABLES) {
      expect(rlsSql).not.toContain(`ALTER TABLE "${t}" ENABLE`);
      expect(consentSql).not.toContain(`ALTER TABLE "${t}" ENABLE`);
    }
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
    expect(m.calls.length).toBe(2);
    expect(m.raw.$transaction).toHaveBeenCalledTimes(1);
    expect(m.calls[0]?.sql).toContain('set_config(');
    expect(m.calls[0]?.values).toEqual([ORGANIZATION_CONTEXT_SETTING, ORG]);
    expect(m.calls[1]?.values).toEqual([LEGACY_ORG_CONTEXT_SETTING, ORG]);
    expect(m.calls[0]?.sql).toMatch(/, true\)$/);
  });

  it('optionally sets app.current_user_id', async () => {
    const m = mockClient();
    await runWithOrgContext(m.client, ORG, async () => null, { userId: USER });
    expect(m.calls.map((c) => c.values)).toEqual([
      ['app.current_organization_id', ORG],
      ['app.current_org_id', ORG],
      ['app.current_user_id', USER],
    ]);
  });

  it('deprecated aliases delegate to the organization names (ADR-010)', async () => {
    expect(runWithOrgContext).toBe(runWithOrganizationContext);
    expect(ORG_CONTEXT_SETTING).toBe(ORGANIZATION_CONTEXT_SETTING);
    expect(LEGACY_ORG_CONTEXT_SETTING).toBe('app.current_org_id');
    const m = mockClient();
    expect(await withOrganizationContext(ORG, async () => 7, { client: m.client })).toBe(7);
    expect(await withOrgContext(ORG, async () => 8, { client: m.client })).toBe(8);
    expect(m.raw.$transaction).toHaveBeenCalledTimes(2);
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
    for (const m of tenantModels) {
      if (ORGANIZATION_KEYED.includes(m.table)) continue;
      expect(m.body, m.name).toContain('@@unique([organizationId, id])');
    }
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
        // auth_refresh_tokens.token_hash (ADR-005 A1.2.1): SHA-256 hashes are globally unique.
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
  it('seed uses organizations/{organizationId}/ prefix (ADR-010, 2026-10-24)', () => {
    const seed = readFileSync(resolve(pkgDir, 'prisma/seed.ts'), 'utf8');
    expect(seed).toContain('`organizations/${org.id}/meetings/');
    expect(seed).not.toContain('`org/${');
    expect(seed).not.toContain('orgs/');
  });

  it('seed is multi-organization and uses withOrganizationContext naming (ADR-010)', () => {
    const seed = readFileSync(resolve(pkgDir, 'prisma/seed.ts'), 'utf8');
    expect((seed.match(/^\s+slug: '(\w+)',$/gm) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(seed).toContain('runWithOrganizationContext(prisma, org.id');
    expect(seed).not.toMatch(/\bwithOrgContext\b|\brunWithOrgContext\b|\borgId\b/);
  });
});

describe('XT-26..XT-28 static guarantees', () => {
  it('XT-26: policies use missing_ok current_setting so no context => NULL => 0 rows', () => {
    const policies = policySql.split(ORG_EXPR).length - 1;
    expect(policies).toBe(
      (TENANT_TABLES.length - ADR010_ONLY_TABLES.length - CONSENT_TABLES.length) * 2,
    );
    expect(consentSql.split(ADR010_EXPR).length - 1).toBe(CONSENT_TABLES.length * 2);
    expect(consentSql).not.toMatch(/current_setting\('app\.current_(org|organization)_id'\)/);
    expect(adr010Sql.split(ADR010_EXPR).length - 1).toBe(ADR010_ONLY_TABLES.length * 2);
    expect(adr010Sql).not.toMatch(/current_setting\('app\.current_(org|organization)_id'\)/);
    expect(policySql).not.toMatch(/current_setting\('app\.current_(org|organization)_id'\)/);
    expect(policySql).not.toMatch(/DROP (TABLE|COLUMN)|RENAME/i);
  });

  it('XT-27: every tenant policy has WITH CHECK', () => {
    // audit_events uses audit_insert (FOR INSERT ... WITH CHECK) instead of tenant_isolation.
    const n = (policySql.match(/CREATE POLICY tenant_isolation[^;]*WITH CHECK/g) ?? []).length;
    expect(n).toBe(TENANT_TABLES.length - 1 - ADR010_ONLY_TABLES.length - CONSENT_TABLES.length);
    expect(consentSql).toMatch(
      /CREATE POLICY consent_insert ON "consent_attestations" FOR INSERT\n {2}WITH CHECK/,
    );
    expect((adr010Sql.match(/CREATE POLICY tenant_isolation[^;]*WITH CHECK/g) ?? []).length).toBe(
      ADR010_ONLY_TABLES.length,
    );
    expect(policySql).toMatch(
      /CREATE POLICY audit_insert ON "audit_events" FOR INSERT\n {2}WITH CHECK/,
    );
  });

  it('XT-28: org context is transaction-local (set_config is_local=true), never session SET', () => {
    const src = readFileSync(resolve(pkgDir, 'src/tenant.ts'), 'utf8');
    expect(src).toMatch(
      /set_config\(\$\{ORGANIZATION_CONTEXT_SETTING\}, \$\{organizationId\}, true\)/,
    );
    expect(src).toMatch(
      /set_config\(\$\{LEGACY_ORG_CONTEXT_SETTING\}, \$\{organizationId\}, true\)/,
    );
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
    expect(models).toHaveLength(43);
    for (const m of models.filter((x) => !ORGANIZATION_KEYED.includes(x.table)))
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
    expect(legacyPolicySql).toContain(
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
    expect(finalSql).toContain(
      `CREATE TYPE "RecordingSource" AS ENUM ('tab', 'mobile', 'desktop');`,
    );
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

const addendum2Sql = readFileSync(
  resolve(migrationsDir, '20261022000000_adr004_addendum2/migration.sql'),
  'utf8',
);

describe('ADR-004 addendum 2 (contracts 0.3.0)', () => {
  it('(a) Prisma exposes organizationId mapped to org_id, never orgId', () => {
    expect(schema).not.toMatch(/\borgId\b/);
    const fields = [
      ...schema.matchAll(/^\s+organizationId\s+String\??\s+(?:@id\s+)?@map\("(\w+)"\)/gm),
    ].map((m) => m[1]);
    expect(fields.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    expect(new Set(fields)).toEqual(new Set(['org_id']));
    const src =
      readFileSync(resolve(pkgDir, 'src/tenant.ts'), 'utf8') +
      readFileSync(resolve(pkgDir, 'src/index.ts'), 'utf8');
    expect(src).not.toMatch(/\borgId\b/);
    expect(src).toContain("'app.current_organization_id'");
    expect(src).toContain("'app.current_org_id'");
  });

  it('(b) extracted_tasks.report_id NOT NULL with a backfill that fails clearly, RLS re-forced', () => {
    expect(finalSql).toMatch(/CREATE TABLE "extracted_tasks" \([\s\S]*?"report_id" UUID NOT NULL,/);
    expect(addendum2Sql).toContain("RAISE EXCEPTION 'ADR-004 addendum 2 (b)");
    expect(addendum2Sql).toContain('ALTER TABLE "extracted_tasks" FORCE ROW LEVEL SECURITY;');
  });

  it('(c) transcripts.provider NOT NULL, legacy rows become unknown', () => {
    expect(finalSql).toMatch(/CREATE TABLE "transcripts" \([\s\S]*?"provider" TEXT NOT NULL,/);
    expect(addendum2Sql).toContain(
      `UPDATE "transcripts" SET "provider" = 'unknown' WHERE "provider" IS NULL;`,
    );
    expect(addendum2Sql).toContain('ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;');
  });

  it('(d) meeting_participants has no employee_id; (e) only tasks.extracted_task_id links tasks', () => {
    const mp = /CREATE TABLE "meeting_participants" \(([\s\S]*?)\n\);/.exec(finalSql)?.[1] ?? '';
    expect(mp).not.toContain('employee_id');
    expect(finalSql).not.toMatch(/accepted_task_id/);
    const et = /CREATE TABLE "extracted_tasks" \(([\s\S]*?)\n\);/.exec(finalSql)?.[1] ?? '';
    expect(et).not.toMatch(/"task_id"/);
    expect(finalSql).toContain(
      'CREATE UNIQUE INDEX "tasks_extracted_task_id_key" ON "tasks"("extracted_task_id");',
    );
  });
});

describe('DB-BUG-2: every setting-based policy is NULLIF-guarded', () => {
  it("the latest definition of each policy reads settings only through NULLIF(..., '')::uuid", () => {
    const latest = new Map<string, string>();
    for (const m of migrationSql.matchAll(/CREATE POLICY (\w+) ON "(\w+)"([\s\S]*?);/g)) {
      latest.set(`${m[2]}.${m[1]}`, m[3] ?? '');
    }
    const withSetting = [...latest].filter(([, body]) => body.includes('current_setting'));
    expect(withSetting.length).toBeGreaterThanOrEqual(TENANT_TABLES.length + 1);
    for (const [name, body] of withSetting) {
      const raw =
        body.match(/current_setting\('app\.current_(org|organization|user)_id', true\)/g) ?? [];
      const guarded =
        body.match(
          /NULLIF\(current_setting\('app\.current_(org|organization|user)_id', true\), ''\)/g,
        ) ?? [];
      expect(guarded.length, name).toBe(raw.length);
      // Every comparison casts once to uuid: either NULLIF(...)::uuid or COALESCE(NULLIF(...), NULLIF(...))::uuid.
      const casts = (body.match(/\)::uuid/g) ?? []).length;
      const coalesced = (body.match(/COALESCE\(NULLIF/g) ?? []).length;
      expect(casts, name).toBe(raw.length - coalesced);
    }
  });
});

const providerSql = readFileSync(
  resolve(migrationsDir, '20261022010000_transcript_provider_check/migration.sql'),
  'utf8',
);

describe('transcripts.provider = contracts TranscriptProviderId', () => {
  it('CHECK values are exactly contracts TRANSCRIPT_PROVIDER_IDS (#50 @ d54330c)', () => {
    /** Pinned from packages/contracts/src/constants.ts at d54330c (contracts #50). */
    const PINNED = ['assemblyai', 'faster-whisper', 'deepgram', 'unknown'];
    const check = /CHECK \("provider" IN \(([^)]*)\)\)/.exec(providerSql)?.[1] ?? '';
    const allowed = [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual(PINNED);
    // Once #50 lands in this tree, compare with the live contracts constant too.
    const constantsPath = resolve(pkgDir, '../contracts/src/constants.ts');
    const constants = existsSync(constantsPath) ? readFileSync(constantsPath, 'utf8') : '';
    if (constants.includes('TRANSCRIPT_PROVIDER_IDS')) {
      const stt = /STT_PROVIDER_IDS = \[([^\]]*)\]/.exec(constants)?.[1] ?? '';
      const fromContracts = [...[...stt.matchAll(/'([^']+)'/g)].map((m) => m[1]), 'unknown'];
      expect(allowed).toEqual(fromContracts);
    } else {
      const jobs = readFileSync(resolve(pkgDir, '../contracts/src/jobs/index.ts'), 'utf8');
      const union =
        /export const SttProviderId = Type\.Union\(\[([\s\S]*?)\]\)/.exec(jobs)?.[1] ?? '';
      expect([
        ...[...union.matchAll(/Type\.Literal\('([^']+)'\)/g)].map((m) => m[1]),
        'unknown',
      ]).toEqual(PINNED);
    }
  });

  it("'unknown' is backfill-only: trigger rejects it on insert/change and there is no column default", () => {
    expect(providerSql).toContain('BEFORE INSERT OR UPDATE OF "provider" ON "transcripts"');
    expect(providerSql).toMatch(
      /NEW\.provider = 'unknown' AND \(TG_OP = 'INSERT' OR OLD\.provider IS DISTINCT FROM NEW\.provider\)/,
    );
    expect(finalSql).toMatch(/CREATE TABLE "transcripts" \([\s\S]*?"provider" TEXT NOT NULL,/);
    expect(addendum2Sql).toContain(`SET "provider" = 'unknown' WHERE "provider" IS NULL`);
  });
});

describe('transcripts.recording_id required (contracts Transcript.recordingId)', () => {
  it('is NOT NULL with a link-or-fail backfill and RLS re-forced', () => {
    const sql = readFileSync(
      resolve(migrationsDir, '20261022020000_transcript_recording_required/migration.sql'),
      'utf8',
    );
    expect(finalSql).toMatch(/CREATE TABLE "transcripts" \([\s\S]*?"recording_id" UUID NOT NULL,/);
    expect(sql).toContain('HAVING count(*) = 1');
    expect(sql).toContain("RAISE EXCEPTION 'transcripts.recording_id NOT NULL");
    expect(sql).toContain('ALTER TABLE "transcripts" FORCE ROW LEVEL SECURITY;');
  });
});

const secDir = (name: string) =>
  readFileSync(resolve(migrationsDir, name, 'migration.sql'), 'utf8');

describe('security review fixes (static)', () => {
  it('BLOCKER: accept_invitation takes the invitation role on conflict', () => {
    expect(secDir('20261022030000_accept_invitation_role')).toContain(
      'ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()',
    );
  });

  it('(1) lookup filters to pending, unexpired, not revoked/deleted, minimal fields', () => {
    const sql = secDir('20261022031000_invitation_lookup_pending');
    for (const f of [
      "i.status = 'pending'",
      'i.expires_at > now()',
      'i.revoked_at IS NULL',
      'i.deleted_at IS NULL',
    ]) {
      expect(sql).toContain(f);
    }
    expect(sql).toContain(
      'RETURNS TABLE (id uuid, org_id uuid, email text, role "MembershipRole", expires_at timestamptz)',
    );
  });

  it('(2) audit append-only trigger; org-NULL inserts only via allowlisted definer', () => {
    const sql = secDir('20261022032000_audit_append_only');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "audit_events"');
    expect(sql).toContain('BEFORE TRUNCATE ON "audit_events"');
    expect(sql).toMatch(
      /CREATE POLICY audit_insert ON "audit_events" FOR INSERT\n\s+WITH CHECK \(org_id = NULLIF/,
    );
    expect(sql).not.toMatch(/org_id IS NULL OR/);
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("RAISE EXCEPTION 'audit_action_not_allowed'");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.record_global_auth_event');
  });

  it('(3) relay reads only through definer functions; no table grants, no BYPASSRLS in scripts', () => {
    const sql = secDir('20261022033000_relay_definer_functions');
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM meetops_relay');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) TO meetops_relay;',
    );
    for (const f of ['scripts/bootstrap-roles.sql', 'scripts/create-db-roles.ts']) {
      const src = readFileSync(resolve(pkgDir, f), 'utf8');
      expect(src, f).not.toMatch(/meetops_relay[^\n]*\bBYPASSRLS/);
      expect(src, f).not.toMatch(/GRANT (SELECT|UPDATE)[^\n]*outbox_events TO meetops_relay/);
    }
  });

  it('(3b) relay claim by event type: definer, least privilege, filters on event_type', () => {
    const sql = secDir('20261028000000_relay_claim_by_event_type');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('c.event_type = ANY (COALESCE(p_event_types, ARRAY[]::text[]))');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.relay_claim_outbox_events(integer, text[]) FROM PUBLIC;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer, text[]) TO meetops_relay;',
    );
    expect(sql).not.toMatch(/GRANT (SELECT|UPDATE|INSERT|DELETE)/);
    for (const f of ['scripts/bootstrap-roles.sql', 'scripts/create-db-roles.ts']) {
      expect(readFileSync(resolve(pkgDir, f), 'utf8'), f).toContain(
        'GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer, text[]) TO meetops_relay;',
      );
    }
  });

  it('(3c) relay loses EXECUTE on the claim-all-kinds overload; scripts no longer grant it', () => {
    const sql = secDir(RELAY_REVOKE_ALL_KINDS_MIGRATION).replace(/--.*$/gm, '');
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) FROM meetops_relay;',
    );
    expect(sql).not.toMatch(/\bGRANT\b|DROP FUNCTION|DISABLE ROW LEVEL SECURITY|NO FORCE/);
    for (const f of ['scripts/bootstrap-roles.sql', 'scripts/create-db-roles.ts']) {
      const src = readFileSync(resolve(pkgDir, f), 'utf8');
      expect(src, f).not.toContain(
        'GRANT EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) TO meetops_relay;',
      );
      expect(src, f).toContain(
        'REVOKE EXECUTE ON FUNCTION public.relay_claim_outbox_events(integer) FROM meetops_relay;',
      );
    }
  });

  it('(4) every NO FORCE is re-forced in the same migration, and a final assertion guards the chain', () => {
    for (const d of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) =>
      e.isDirectory(),
    )) {
      const sql = secDir(d.name);
      // Prisma sends each file as one multi-statement query: Postgres runs it as one implicit transaction,
      // and statements after an explicit COMMIT form one more implicit transaction (both verified live).
      // So any explicit BEGIN/COMMIT must come before the first NO FORCE, keeping the window atomic.
      const firstNoForce = sql.indexOf('NO FORCE ROW LEVEL SECURITY');
      if (firstNoForce >= 0) {
        const txControl = [...sql.matchAll(/^\s*(BEGIN|COMMIT)\s*;/gim)].map((m) => m.index ?? 0);
        expect(
          txControl.filter((i) => i > firstNoForce),
          d.name,
        ).toEqual([]);
      }
      for (const m of sql.matchAll(/ALTER TABLE "(\w+)" NO FORCE ROW LEVEL SECURITY;/g)) {
        const after = sql.slice((m.index ?? 0) + m[0].length);
        expect(after, `${d.name}: ${m[1]}`).toContain(
          `ALTER TABLE "${m[1]}" FORCE ROW LEVEL SECURITY;`,
        );
      }
    }
    expect(secDir('20261022034000_assert_forced_rls')).toContain(
      "RAISE EXCEPTION 'RLS enabled but not forced on: %'",
    );
  });
});

describe('architecture review B1 and audit hatch (static)', () => {
  it('B1: accept_invitation refuses active members and only revives soft-deleted rows', () => {
    const sql = secDir('20261022040000_accept_invitation_active_member');
    expect(sql).toContain("RAISE EXCEPTION 'already_member'");
    expect(sql).toMatch(/m\.deleted_at IS NULL\s+FOR UPDATE;/);
    expect(sql).toContain(
      'ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()\n  WHERE memberships.deleted_at IS NOT NULL',
    );
  });

  it('audit maintenance hatch keys on session_user, not current_user', () => {
    const sql = secDir('20261022041000_audit_hatch_session_user');
    expect(sql).toContain("AND session_user = 'meetops_migrator' THEN");
    expect(sql).not.toMatch(/pg_has_role\(current_user/);
  });
});

describe('DB-1 teams and team_members (static)', () => {
  const model = (name: string) => models.find((m) => m.name === name)?.body ?? '';

  it('are tenant tables in TENANT_TABLES with per-org uniques', () => {
    expect(TENANT_TABLES).toEqual(expect.arrayContaining(['teams', 'team_members']));
    expect(model('Team')).toContain('@@unique([organizationId, id])');
    expect(model('Team')).toContain('@@unique([organizationId, name])');
    expect(model('TeamMember')).toContain('@@unique([organizationId, teamId, employeeId])');
    expect(schema).toMatch(/enum TeamMemberRole \{\s+lead\s+member\s+\}/);
  });

  it('links teams, employees and projects only through composite (org_id, id) FKs', () => {
    for (const fk of [
      'ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "teams"("org_id", "id")',
      'ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_employee_id_fkey" FOREIGN KEY ("org_id", "employee_id") REFERENCES "employees"("org_id", "id")',
      'ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_team_id_fkey" FOREIGN KEY ("org_id", "team_id") REFERENCES "teams"("org_id", "id") ON DELETE RESTRICT',
    ])
      expect(teamsSql).toContain(fk);
    expect(teamsSql).not.toMatch(/REFERENCES "(teams|employees)"\("id"\)/);
  });

  it('is additive, forced, uses only the ADR-010 setting, grants the app role and re-asserts FORCE', () => {
    expect(teamsSql).not.toMatch(/DROP |RENAME|NO FORCE/);
    expect(teamsSql).not.toContain('COALESCE');
    expect(teamsSql).not.toContain('app.current_org_id');
    expect(teamsSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "teams", "team_members" TO meetops_app;',
    );
    expect(teamsSql).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
  });

  it('migration sorts after every earlier migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs.indexOf('20261025090000_teams')).toBe(dirs.indexOf(CONSENT_MIGRATION) - 1);
  });
});

describe('DB-3 consent_attestations, scan_status and storage-key CHECKs (static)', () => {
  const model = (name: string) => models.find((m) => m.name === name)?.body ?? '';
  const statements = consentSql.replace(/--.*$/gm, '');

  it('sorts immediately before the meetings external id migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs.indexOf(CONSENT_MIGRATION)).toBe(dirs.indexOf(MEETINGS_EXTERNAL_ID_MIGRATION) - 1);
  });

  it('is additive only: no drop, rename, retype or NO FORCE of existing objects', () => {
    expect(statements).not.toMatch(/\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|TYPE\s+"?\w+"?\s+USING/i);
    const alters = statements.match(/ALTER TABLE "file_objects" [A-Z]+ [A-Z]+/g) ?? [];
    expect([...new Set(alters)].sort()).toEqual([
      'ALTER TABLE "file_objects" ADD COLUMN',
      'ALTER TABLE "file_objects" ADD CONSTRAINT',
      'ALTER TABLE "file_objects" VALIDATE CONSTRAINT',
    ]);
  });

  it("adds file_objects.scan_status defaulting to 'pending'", () => {
    expect(schema).toMatch(
      /enum FileScanStatus \{\s+pending\s+clean\s+quarantined\s+rejected\s+\}/,
    );
    expect(model('FileObject')).toMatch(
      /scanStatus\s+FileScanStatus\s+@default\(pending\) @map\("scan_status"\)/,
    );
    expect(consentSql).toContain(
      `ALTER TABLE "file_objects" ADD COLUMN     "scan_status" "FileScanStatus" NOT NULL DEFAULT 'pending';`,
    );
  });

  it('binds storage_key to the org prefix (and legacy org/) and validates the sha256 CHECK, after a preflight', () => {
    const pre = consentSql.indexOf('consent_scan_keycheck preflight failed');
    const key = consentSql.indexOf('ADD CONSTRAINT "file_objects_storage_key_org_check"');
    const sha = consentSql.indexOf('VALIDATE CONSTRAINT "file_objects_checksum_sha256_check"');
    expect(pre).toBeGreaterThan(0);
    expect(key).toBeGreaterThan(pre);
    expect(sha).toBeGreaterThan(pre);
    expect(consentSql).toContain(
      `starts_with("storage_key", 'organizations/' || "org_id"::text || '/')`,
    );
    expect(consentSql).toContain(`starts_with("storage_key", 'org/' || "org_id"::text || '/')`);
    expect(consentSql).not.toMatch(/file_objects_storage_key_org_check"[^;]*NOT VALID/);
  });

  it('consent_attestations is a forced-RLS, append-only tenant table with server-side columns', () => {
    expect(TENANT_TABLES).toContain('consent_attestations');
    const m = model('ConsentAttestation');
    expect(m).toContain('@@unique([organizationId, id])');
    expect(m).toContain('@@index([organizationId, subjectType, subjectId])');
    expect(m).toMatch(/attestedByUserId\s+String\s+@map\("attested_by_user_id"\)/);
    expect(m).toMatch(/recordedAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(m).not.toMatch(/updatedAt|deletedAt/);
    expect(consentSql).toContain('REVOKE ALL ON TABLE "consent_attestations" FROM meetops_app;');
    expect(consentSql).toContain(
      'GRANT SELECT, INSERT ON TABLE "consent_attestations" TO meetops_app;',
    );
    expect(consentSql).not.toMatch(
      /GRANT [^;]*(UPDATE|DELETE|TRUNCATE)[^;]*"consent_attestations"/,
    );
    expect(consentSql).toMatch(/BEFORE UPDATE OR DELETE ON "consent_attestations"/);
    expect(consentSql).toMatch(/BEFORE TRUNCATE ON "consent_attestations"/);
    expect(consentSql).toMatch(/AFTER INSERT ON "consent_attestations"/);
    expect(consentSql).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
    expect(consentSql).toContain(`CHECK ("consent_version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$')`);
    expect(consentSql).toContain(`CHECK ("attested_at" <= "recorded_at" + interval '300 seconds')`);
  });
});

describe('API-MEETINGS meetings.external_meeting_id (static)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, MEETINGS_EXTERNAL_ID_MIGRATION, 'migration.sql'),
    'utf8',
  );
  it('sorts before the auth token families migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    expect(dirs.indexOf(MEETINGS_EXTERNAL_ID_MIGRATION)).toBeLessThan(
      dirs.indexOf(AUTH_TOKENS_MIGRATION),
    );
  });

  it('is additive and adds the per-org idempotency key and keyset index', () => {
    expect(sql).not.toMatch(/DROP |RENAME|NO FORCE|DISABLE ROW LEVEL SECURITY/);
    expect(sql).toContain('ADD COLUMN "external_meeting_id" TEXT');
    expect(sql).toMatch(
      /UNIQUE INDEX "meetings_org_id_source_external_meeting_id_key"\s+ON "meetings"\("org_id", "source", "external_meeting_id"\)/,
    );
    expect(sql).toMatch(
      /INDEX "meetings_org_id_created_at_id_idx"\s+ON "meetings"\("org_id", "created_at", "id"\)/,
    );
  });
});

describe('ADR-005 durable token families (static)', () => {
  const statements = authTokensSql.replace(/--.*$/gm, '');
  it('sorts just before the integration connections migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    expect(dirs.indexOf(AUTH_TOKENS_MIGRATION)).toBe(
      dirs.indexOf(INTEGRATION_CONNECTIONS_MIGRATION) - 1,
    );
  });
  it('is additive only', () => {
    expect(statements).not.toMatch(
      /\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
  });
  it('stores refresh tokens only as SHA-256 hex hashes', () => {
    expect(authTokensSql).toContain(`CHECK ("token_hash" ~ '^[0-9a-f]{64}$')`);
    for (const t of ['auth_devices', 'auth_token_families', 'auth_refresh_tokens']) {
      const body =
        new RegExp(`CREATE TABLE "${t}" \\(([\\s\\S]*?)\\);`).exec(authTokensSql)?.[1] ?? '';
      expect(body, t).not.toMatch(/"(token|refresh_token|access_token|pairing_code)"/);
    }
  });
  it('carries an audience on devices and families', () => {
    expect(schema).toMatch(/enum AuthTokenAudience \{\s+extension\s+desktop\s+\}/);
    expect(authTokensSql.match(/"audience" "AuthTokenAudience" NOT NULL/g)).toHaveLength(2);
  });
  it('grants the app no DELETE and re-asserts forced RLS', () => {
    expect(authTokensSql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "auth_devices", "auth_token_families", "auth_refresh_tokens" TO meetops_app;',
    );
    expect(statements).not.toMatch(/GRANT [^;]*DELETE/);
    // Default privileges grant DELETE on new tables, so it must be revoked explicitly.
    expect(authTokensSql).toContain(
      'REVOKE DELETE ON TABLE "auth_devices", "auth_token_families", "auth_refresh_tokens" FROM meetops_app;',
    );
    expect(authTokensSql).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
  });
});

const TRANSCRIPT_REVISION_MIGRATION = TRANSCRIPT_REVISION_MIGRATION_DIR;

describe('Phase 3 transcripts revised per recording (static)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, TRANSCRIPT_REVISION_MIGRATION, 'migration.sql'),
    'utf8',
  ).replace(/--.*$/gm, '');
  const transcript = models.find((m) => m.name === 'Transcript')?.body ?? '';

  it('sorts before the auth token families migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs.indexOf(TRANSCRIPT_REVISION_MIGRATION)).toBeLessThan(
      dirs.indexOf(AUTH_TOKENS_MIGRATION),
    );
  });

  it('moves the revision key to (recording_id, revision) and keeps revisions non-negative', () => {
    expect(sql).toContain('DROP INDEX IF EXISTS "transcripts_meeting_id_revision_key"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "transcripts_recording_id_revision_key" ON "transcripts"("recording_id", "revision")',
    );
    expect(sql).toContain('CHECK ("revision" >= 0)');
    expect(transcript).toContain('@@unique([recordingId, revision])');
    expect(transcript).not.toContain('@@unique([meetingId, revision])');
  });

  it('only adds a nullable merge_state column (no table drop, no RLS change)', () => {
    expect(sql).toContain('ADD COLUMN "merge_state" JSONB');
    expect(sql).not.toMatch(
      /DROP TABLE|DROP COLUMN|NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/i,
    );
    expect(transcript).toMatch(/mergeState\s+Json\?/);
  });
});

describe('DB recording_source_native: RecordingSource mobile/desktop (static)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, RECORDING_SOURCE_NATIVE_MIGRATION, 'migration.sql'),
    'utf8',
  );
  const statements = sql.replace(/--.*$/gm, '');

  it('sorts after the Phase 3 transcript revision and before auth token families', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    const i = dirs.indexOf(RECORDING_SOURCE_NATIVE_MIGRATION);
    expect(i).toBeGreaterThan(dirs.indexOf(TRANSCRIPT_REVISION_MIGRATION_DIR));
    expect(i).toBeLessThan(dirs.indexOf(AUTH_TOKENS_MIGRATION));
  });

  it('only adds the two enum values, matching the schema and contracts 0.6.0', () => {
    expect(statements).not.toMatch(/DROP|RENAME|CREATE TABLE|ALTER TABLE|NO FORCE/i);
    expect(statements).toContain(`ALTER TYPE "RecordingSource" ADD VALUE IF NOT EXISTS 'mobile';`);
    expect(statements).toContain(`ALTER TYPE "RecordingSource" ADD VALUE IF NOT EXISTS 'desktop';`);
    expect(schema).toMatch(/enum RecordingSource \{\s+tab\s+mobile\s+desktop\s+\}/);
  });
});

describe('Phase 5 integration_connections (static)', () => {
  const statements = integrationsSql.replace(/--.*$/gm, '');
  const model = models.find((m) => m.name === 'IntegrationConnection')?.body ?? '';

  it('sorts just before the report summary dedupe migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    expect(dirs.indexOf(INTEGRATION_CONNECTIONS_MIGRATION)).toBe(
      dirs.indexOf(INTEGRATION_ROUTING_MIGRATION) - 1,
    );
    expect(dirs.indexOf(INTEGRATION_ROUTING_MIGRATION)).toBe(
      dirs.indexOf(REPORT_SUMMARY_DEDUPE_MIGRATION) - 1,
    );
  });

  it('is additive only', () => {
    expect(statements).not.toMatch(
      /\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
  });

  it('is a forced-RLS tenant table bound to org_id', () => {
    expect(TENANT_TABLES).toContain('integration_connections');
    expect(integrationsSql).toContain(
      'ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;',
    );
    expect(integrationsSql).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
    expect(model).toContain('@@unique([organizationId, provider, externalAccountId])');
    expect(model).toContain('@@unique([organizationId, id])');
  });

  it('stores secrets only as v1 envelopes, never plaintext columns', () => {
    for (const c of ['access_token_enc', 'refresh_token_enc', 'webhook_secret_enc']) {
      expect(integrationsSql).toContain(`"integration_connections_${c}_check" CHECK (`);
    }
    expect(model).not.toMatch(/^\s+(accessToken|refreshToken|webhookSecret)\s/m);
    expect(statements).not.toMatch(/"(access_token|refresh_token|webhook_secret)" /);
    expect(model).toMatch(/tokenKeyId\s+String\s+@map\("token_key_id"\)/);
  });

  it('app role cannot DELETE: disconnect is a soft revoke that wipes the secrets (CHECK-enforced)', () => {
    expect(integrationsSql).toContain(
      'REVOKE DELETE, TRUNCATE ON TABLE "integration_connections" FROM meetops_app;',
    );
    expect(integrationsSql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "integration_connections" TO meetops_app;',
    );
    expect(statements).not.toMatch(/GRANT[^;]*DELETE[^;]*"integration_connections"/);
    expect(statements).toMatch(/"integration_connections_revoked_wipe_check" CHECK \(/);
    expect(statements).toMatch(
      /"status" = 'revoked' AND "revoked_at" IS NOT NULL\s+AND "access_token_enc" IS NULL AND "refresh_token_enc" IS NULL AND "webhook_secret_enc" IS NULL/,
    );
    expect(model).toMatch(/revokedAt\s+DateTime\?\s+@map\("revoked_at"\)/);
  });
});

describe('Phase 3 report summary dedupe (static)', () => {
  const statements = reportDedupeSql.replace(/--.*$/gm, '');
  const model = models.find((m) => m.name === 'Report')?.body ?? '';

  it('sorts before the recording bytes, routing policy and notifications migrations', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    const at = (m: string) => dirs.indexOf(m);
    expect(at(RECORDING_BYTES_MIGRATION)).toBe(at(REPORT_SUMMARY_DEDUPE_MIGRATION) + 1);
    expect(at(NOTIFICATIONS_MIGRATION)).toBe(at(INTEGRATION_ROUTING_POLICY_MIGRATION) + 1);
  });

  it('is additive only and keeps RLS untouched', () => {
    expect(statements).not.toMatch(
      /\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY|POLICY|GRANT|NOT NULL/i,
    );
  });

  it('adds one unique index on (meeting, transcript, revision, prompt version) matching the schema', () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX "reports_summary_dedupe_key" ON "reports"\("meeting_id", "transcript_id", "transcript_revision", "prompt_version"\)/,
    );
    expect(model).toContain(
      '@@unique([meetingId, transcriptId, transcriptRevision, promptVersion], map: "reports_summary_dedupe_key")',
    );
  });
});

describe('integration routing definer functions', () => {
  const sql = readFileSync(
    resolve(migrationsDir, '20261027100000_integration_routing_functions/migration.sql'),
    'utf8',
  );
  for (const fn of [
    'integration_connection_org(uuid, text)',
    'integration_connections_due_for_refresh(timestamptz, integer)',
  ]) {
    it(`${fn} is locked down`, () => {
      expect(sql).toContain(`ALTER FUNCTION ${fn} OWNER TO meetops_migrator;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO meetops_app;`);
    });
  }
  it('are SECURITY DEFINER with a fixed search_path and never return secret columns', () => {
    expect(sql.match(/SECURITY DEFINER\nSET search_path = public, pg_temp/g)).toHaveLength(2);
    const bodies = sql.match(/AS \$\$[\s\S]*?\$\$;/g) ?? [];
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).not.toMatch(/_enc|display_name|\*/);
    expect(sql).toContain("c.status <> 'revoked'");
  });
});

describe('integration external-account routing (20261028020000)', () => {
  it('sorts right after the ADR-014 geoip migration, before the relay revoke one', () => {
    const dirs = orderedDirs();
    expect(dirs.at(-1)).toBe(LATEST_MIGRATION);
    expect(dirs.at(-2)).toBe(MEETING_EMBEDDINGS_MIGRATION);
    expect(dirs.at(-3)).toBe(CALENDAR_EVENTS_MIGRATION);
    expect(dirs.at(-4)).toBe(MEETING_SEARCH_MIGRATION);
    expect(dirs.at(-5)).toBe(CALENDAR_CONNECTIONS_MIGRATION);
    expect(dirs.at(-6)).toBe(RETENTION_OWNER_MIGRATION);
    expect(dirs.at(-7)).toBe(RELAY_REVOKE_ALL_KINDS_MIGRATION);
    expect(dirs.at(-8)).toBe(EXTERNAL_ACCOUNT_ROUTING_MIGRATION);
    expect(dirs.at(-9)).toBe(SESSION_AUDIT_GEOIP_MIGRATION);
    expect(dirs.at(-10)).toBe(RELAY_BY_TYPE_MIGRATION);
  });
  const sql = readFileSync(
    resolve(migrationsDir, EXTERNAL_ACCOUNT_ROUTING_MIGRATION, 'migration.sql'),
    'utf8',
  ).replace(/--.*$/gm, '');
  it('is a SECURITY DEFINER, identifiers-only, live-rows function granted to the app role only', () => {
    expect(sql).toMatch(
      /CREATE FUNCTION integration_connections_by_external_account\(p_provider text, p_external_account_id text\)/,
    );
    expect(sql).toMatch(/RETURNS TABLE \(org_id uuid, id uuid\)/);
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(sql).toMatch(/c\.status <> 'revoked'/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION integration_connections_by_external_account\(text, text\) FROM PUBLIC;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION integration_connections_by_external_account\(text, text\) TO meetops_app;/,
    );
    expect(sql).not.toMatch(/_enc\b|secret|access_token/i);
    expect(sql).not.toMatch(/\bDROP\b|ALTER TABLE|DISABLE ROW LEVEL SECURITY|NO FORCE/i);
  });
});

describe('ADR-013 notifications tables (static)', () => {
  const statements = notificationsSql.replace(/--.*$/gm, '');

  it('keeps its place in the migration order and is additive only', () => {
    const dirs = orderedDirs();
    expect(dirs.at(-10)).toBe(RELAY_BY_TYPE_MIGRATION);
    expect(dirs.at(-11)).toBe(NOTIFICATIONS_MIGRATION);
    expect(statements).not.toMatch(
      /\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
  });

  it('enables and forces RLS with an ADR-010 tenant policy on every table, and grants the app role', () => {
    for (const t of NOTIFICATION_TABLES) {
      expect(TENANT_TABLES as readonly string[]).toContain(t);
      expect(statements).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(statements).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
      expect(statements).toContain(`CREATE POLICY tenant_isolation ON "${t}"`);
    }
    expect(statements).not.toContain('app.current_org_id');
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notifications", "notification_delivery_attempts", "notification_preferences", "push_device_tokens" TO meetops_app;',
    );
    expect(statements).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
  });

  it('adds a restrictive owner-only policy on user-owned tables', () => {
    for (const t of ['notifications', 'notification_preferences', 'push_device_tokens'])
      expect(statements).toContain(`CREATE POLICY owner_only ON "${t}" AS RESTRICTIVE`);
  });

  it('links attempts to notifications through a composite tenant FK and stores push tokens only hashed + encrypted', () => {
    expect(statements).toContain(
      'FOREIGN KEY ("org_id", "notification_id") REFERENCES "notifications"("org_id", "id")',
    );
    const push = /CREATE TABLE "push_device_tokens" \(([\s\S]*?)\);/.exec(statements)?.[1] ?? '';
    expect(push).toContain('"token_hash" TEXT NOT NULL');
    expect(push).toContain('"token_enc" TEXT');
    expect(push).not.toMatch(/"(token|endpoint)" /);
    expect(statements).toContain('"push_device_tokens"("org_id", "token_hash")');
  });
});

describe('integration routing definer policy (20261027140000)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, INTEGRATION_ROUTING_POLICY_MIGRATION, 'migration.sql'),
    'utf8',
  );
  it('is SELECT-only, TO meetops_migrator, live rows only, and grants meetops_app nothing', () => {
    expect(sql).toMatch(
      /CREATE POLICY definer_integration_routing_select ON "integration_connections"\s+FOR SELECT\s+TO meetops_migrator\s+USING \(status <> 'revoked'\);/,
    );
    expect(sql).not.toMatch(/WITH CHECK/);
    expect(sql).not.toMatch(/TO meetops_app\b/);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE/i);
  });
  it('sorts right after the recording bytes migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    expect(dirs.indexOf(INTEGRATION_ROUTING_POLICY_MIGRATION)).toBe(
      dirs.indexOf(RECORDING_BYTES_MIGRATION) + 1,
    );
  });
});

describe('IP retention owner re-assert (20261028040000)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, RETENTION_OWNER_MIGRATION, 'migration.sql'),
    'utf8',
  ).replace(/--.*$/gm, '');
  it('is the newest migration, after the ADR-014 geoip one', () => {
    const dirs = orderedDirs();
    expect(dirs.at(-1)).toBe(LATEST_MIGRATION);
    expect(dirs.at(-2)).toBe(MEETING_EMBEDDINGS_MIGRATION);
    expect(dirs.at(-3)).toBe(CALENDAR_EVENTS_MIGRATION);
    expect(dirs.at(-4)).toBe(MEETING_SEARCH_MIGRATION);
    expect(dirs.at(-5)).toBe(CALENDAR_CONNECTIONS_MIGRATION);
    expect(dirs.at(-6)).toBe(RETENTION_OWNER_MIGRATION);
    expect(dirs.indexOf(RETENTION_OWNER_MIGRATION)).toBeGreaterThan(
      dirs.indexOf(SESSION_AUDIT_GEOIP_MIGRATION),
    );
  });
  it('only re-owns the three tables to meetops_migrator (guarded) and re-issues the column grants', () => {
    expect(sql).toMatch(/pg_has_role\(current_user, 'meetops_migrator', 'MEMBER'\)/);
    expect(sql).toMatch(/ARRAY\['sessions', 'password_resets', 'audit_events'\]/);
    expect(sql).toMatch(/ALTER TABLE %I OWNER TO meetops_migrator/);
    expect(sql).toContain(
      'GRANT SELECT (id, ip_address, created_at), UPDATE (ip_address)\n  ON TABLE "sessions", "password_resets", "audit_events" TO meetops_migrator;',
    );
    expect(sql).not.toMatch(/meetops_app|\bDROP\b|DISABLE ROW LEVEL SECURITY|NO FORCE/i);
  });
});

describe('Phase 7 calendar_connections (static)', () => {
  const sql = calendarSql;
  const statements = sql.replace(/--.*$/gm, '');
  const model = models.find((m) => m.name === 'CalendarConnection')?.body ?? '';

  it('is additive, forced-RLS, envelope-only and soft-delete only', () => {
    expect(statements).not.toMatch(
      /\bDROP\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
    expect(TENANT_TABLES).toContain('calendar_connections');
    expect(sql).toContain('ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON TABLE "calendar_connections" FROM meetops_app;',
    );
    for (const c of ['access_token_enc', 'refresh_token_enc']) {
      expect(sql).toContain(`"calendar_connections_${c}_check" CHECK (`);
    }
    expect(statements).toMatch(/"calendar_connections_revoked_wipe_check" CHECK \(/);
    expect(model).not.toMatch(/^\s+(accessToken|refreshToken)\s/m);
    expect(model).toContain(
      '@@unique([organizationId, userId, provider, externalAccountId], map: "calendar_connections_org_id_user_id_provider_external_account_i")',
    );
    // The default name is 68 chars; Postgres truncates it to 63, which is what the migration created.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "calendar_connections_org_id_user_id_provider_external_account_id_key"',
    );
    expect('calendar_connections_org_id_user_id_provider_external_account_i').toHaveLength(63);
  });
});

describe('Phase 7 meeting search FTS indexes (static)', () => {
  const sql = readFileSync(
    resolve(migrationsDir, MEETING_SEARCH_MIGRATION, 'migration.sql'),
    'utf8',
  );
  const statements = sql.replace(/--.*$/gm, '');
  it('only adds GIN expression indexes (no policy, grant, column or RLS changes)', () => {
    const stmts = statements
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);
    expect(stmts).toHaveLength(4);
    for (const st of stmts)
      expect(st).toMatch(
        /^CREATE INDEX "\w+_search_fts_idx" ON "\w+"\s+USING GIN \(to_tsvector\('english'::regconfig, /,
      );
    expect(statements).not.toMatch(/POLICY|GRANT|REVOKE|ROW LEVEL SECURITY|ALTER TABLE|DROP/i);
  });
});

describe('Phase 7 calendar_events + sync cursor (static)', () => {
  const statements = calendarEventsSql.replace(/--.*$/gm, '');
  const model = models.find((m) => m.name === 'CalendarEvent')?.body ?? '';

  it('is additive only and forces RLS with an ADR-010 tenant policy; the app role cannot DELETE', () => {
    expect(statements).not.toMatch(
      /\bDROP (TABLE|COLUMN|FUNCTION)\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
    expect(TENANT_TABLES).toContain('calendar_events');
    expect(statements).toContain('ALTER TABLE "calendar_events" FORCE ROW LEVEL SECURITY;');
    expect(statements).toContain('CREATE POLICY tenant_isolation ON "calendar_events"');
    expect(statements).not.toContain('app.current_org_id');
    expect(statements).toContain(
      'REVOKE DELETE, TRUNCATE ON TABLE "calendar_events" FROM meetops_app;',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "calendar_events" TO meetops_app;',
    );
    expect(statements).toContain("RAISE EXCEPTION 'RLS enabled but not forced on: %'");
  });

  it('ties events to their connection through a composite tenant FK and https-only links', () => {
    expect(statements).toContain(
      'FOREIGN KEY ("org_id", "connection_id") REFERENCES "calendar_connections"("org_id", "id")',
    );
    expect(statements).toMatch(
      /"calendar_events_conference_url_check" CHECK \("conference_url" IS NULL OR "conference_url" ~ '\^https:\/\/'\)/,
    );
    expect(statements).toMatch(
      /"calendar_events_status_check" CHECK \("status" IN \('confirmed', 'tentative', 'cancelled'\)\)/,
    );
    expect(model).toContain('@@unique([organizationId, connectionId, providerEventId])');
  });

  it('routes the sweep through an identifiers-only SECURITY DEFINER function and a SELECT-only migrator policy', () => {
    expect(statements).toMatch(
      /CREATE FUNCTION calendar_connections_due_for_sync\(p_now timestamptz, p_limit integer\)\s+RETURNS TABLE \(org_id uuid, id uuid, user_id uuid, provider text\)/,
    );
    expect(statements).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    const body = /AS \$\$([\s\S]*?)\$\$;/.exec(statements)?.[1] ?? '';
    expect(body).not.toMatch(/_enc|display_name|\*/);
    expect(body).toContain("c.status = 'active'");
    expect(statements).toMatch(
      /CREATE POLICY definer_calendar_sync_select ON "calendar_connections"\s+FOR SELECT\s+TO meetops_migrator\s+USING \(status = 'active'\);/,
    );
    expect(statements).toContain(
      'REVOKE ALL ON FUNCTION calendar_connections_due_for_sync(timestamptz, integer) FROM PUBLIC;',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION calendar_connections_due_for_sync(timestamptz, integer) TO meetops_app;',
    );
    expect(statements).not.toMatch(/GRANT [^;]*"calendar_connections"[^;]*TO meetops_app/);
  });

  it("#324 L-3: purges a revoked connection's events only through an org-context-checked definer function", () => {
    const fn =
      /CREATE FUNCTION calendar_events_purge_for_connection\(p_org uuid, p_connection uuid\)[\s\S]*?\$\$;/.exec(
        statements,
      )?.[0] ?? '';
    expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(fn).toContain(
      "current_setting('app.current_organization_id', true) IS DISTINCT FROM p_org::text",
    );
    expect(fn).toContain("c.status = 'revoked'");
    expect(fn).toContain(
      'DELETE FROM public.calendar_events e WHERE e.org_id = p_org AND e.connection_id = p_connection',
    );
    expect(statements).toContain(
      'ALTER FUNCTION calendar_events_purge_for_connection(uuid, uuid) OWNER TO meetops_migrator;',
    );
    expect(statements).toContain(
      'REVOKE ALL ON FUNCTION calendar_events_purge_for_connection(uuid, uuid) FROM PUBLIC;',
    );
    expect(statements).toContain(
      'GRANT EXECUTE ON FUNCTION calendar_events_purge_for_connection(uuid, uuid) TO meetops_app;',
    );
  });
});

describe('Phase 7 meeting_embeddings (static)', () => {
  const statements = meetingEmbeddingsSql.replace(/--.*$/gm, '');
  const model = models.find((m) => m.name === 'MeetingEmbedding')?.body ?? '';

  it('is additive only, forces RLS with an ADR-010 tenant policy and is a registered tenant table', () => {
    expect(statements).not.toMatch(
      /\bDROP (TABLE|COLUMN|FUNCTION|EXTENSION)\b|RENAME|ALTER COLUMN|NO FORCE|DISABLE ROW LEVEL SECURITY/i,
    );
    expect(statements).toContain('CREATE EXTENSION IF NOT EXISTS "vector";');
    expect(TENANT_TABLES).toContain('meeting_embeddings');
    expect(statements).toContain('ALTER TABLE "meeting_embeddings" FORCE ROW LEVEL SECURITY;');
    expect(statements).toContain(`USING (org_id = ${ADR010_EXPR})`);
    expect(statements).toContain(`WITH CHECK (org_id = ${ADR010_EXPR})`);
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "meeting_embeddings" TO meetops_app;',
    );
  });

  it('only points at same-org sources, stores no content and has no cross-tenant ANN index', () => {
    for (const fk of [
      'FOREIGN KEY ("org_id", "meeting_id") REFERENCES "meetings"("org_id", "id")',
      'FOREIGN KEY ("org_id", "segment_id") REFERENCES "transcript_segments"("org_id", "id")',
      'FOREIGN KEY ("org_id", "report_id") REFERENCES "reports"("org_id", "id")',
    ])
      expect(statements).toContain(fk);
    expect(statements).toContain('"embedding" vector(1536) NOT NULL');
    expect(statements).not.toMatch(/"(content|text|summary)" TEXT/);
    expect(statements).not.toMatch(/USING\s+(hnsw|ivfflat)/i);
    expect(statements).toContain(
      'CREATE INDEX "meeting_embeddings_org_id_model_idx" ON "meeting_embeddings"("org_id", "model");',
    );
    expect(model).toContain('Unsupported("vector(1536)")');
  });
});
