/**
 * DB-3 (G6 + G11), live: consent_attestations (forced RLS, append-only, same-org subject), file_objects.scan_status
 * (default 'pending'), the storage-key org-prefix CHECK and the validated hex sha256 CHECK. The scratch-database
 * suite applies the real migration files to prove 20261025120000_consent_scan_keycheck fails loudly, and atomically,
 * on an existing row that violates a new CHECK.
 *
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL are set; the scratch suite also needs RLS_TEST_ADMIN_URL
 * (a superuser that may CREATE DATABASE).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import {
  CONSENT_ATTESTATION_MAX_SKEW_SECONDS,
  CURRENT_CONSENT_VERSION,
  FILE_OBJECT_SCAN_STATUSES,
} from '../src/consent.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;

const MIGRATION = '20261025120000_consent_scan_keycheck';
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(PKG_DIR, 'prisma/migrations');
const PRISMA_CLI = join(PKG_DIR, 'node_modules/prisma/build/index.js');

const dbError = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError
    ? `${e.code} ${e.message} ${JSON.stringify(e.meta ?? {})}`
    : String(e);

describe.skipIf(!APP_URL || !OWNER_URL)('consent attestations and file scan state (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userId = randomUUID();
  let fileA = '';
  let fileB = '';
  let sessionA = '';

  const inOrg = <T>(org: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(app, org, fn);
  const attest = (
    org: string,
    data: Partial<Prisma.ConsentAttestationUncheckedCreateInput> = {},
    client: PrismaClient = app,
  ) =>
    runWithOrganizationContext(client, org, (tx) =>
      tx.consentAttestation.create({
        data: {
          organizationId: org,
          subjectType: 'upload',
          subjectId: fileA,
          consentVersion: CURRENT_CONSENT_VERSION,
          method: 'all_parties_consented',
          attestedByUserId: userId,
          attestedAt: new Date(),
          ...data,
        },
      }),
    );
  const createFile = (org: string, key: string, checksumSha256?: string) =>
    inOrg(org, (tx) =>
      tx.fileObject.create({
        data: {
          organizationId: org,
          bucket: 'b',
          key,
          mimeType: 'audio/webm',
          ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
        },
      }),
    );

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'C', slug: `c-${orgA}` },
        { id: orgB, name: 'C2', slug: `c2-${orgB}` },
      ],
    });
    await owner.user.create({ data: { id: userId, email: `consent-${userId}@example.test` } });
    fileA = (await createFile(orgA, `organizations/${orgA}/uploads/${randomUUID()}.webm`)).id;
    fileB = (await createFile(orgB, `organizations/${orgB}/uploads/${randomUUID()}.webm`)).id;
    sessionA = await runWithOrganizationContext(owner, orgA, async (tx) => {
      const meeting = await tx.meeting.create({ data: { organizationId: orgA, title: 'c' } });
      const s = await tx.recordingSession.create({
        data: {
          organizationId: orgA,
          meetingId: meeting.id,
          mimeType: 'audio/webm',
          startedAt: new Date(),
        },
      });
      return s.id;
    });
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  describe('file_objects', () => {
    it("scan_status defaults to 'pending' and accepts every contract status", async () => {
      const f = await createFile(orgA, `organizations/${orgA}/x/${randomUUID()}`);
      expect(f.scanStatus).toBe('pending');
      for (const scanStatus of FILE_OBJECT_SCAN_STATUSES) {
        const u = await inOrg(orgA, (tx) =>
          tx.fileObject.update({ where: { id: f.id }, data: { scanStatus } }),
        );
        expect(u.scanStatus).toBe(scanStatus);
      }
    });

    it('raw inserts that omit scan_status (media.ts chunk rows) also get pending', async () => {
      const id = randomUUID();
      await inOrg(
        orgA,
        (tx) =>
          tx.$executeRaw`INSERT INTO "file_objects" ("id", "org_id", "bucket", "storage_key", "mime_type",
          "updated_at") VALUES (${id}::uuid, ${orgA}::uuid, 'b', ${`org/${orgA}/raw/${id}`}, 'audio/wav', now())`,
      );
      const [row] = await inOrg(
        orgA,
        (tx) =>
          tx.$queryRaw<
            { s: string }[]
          >`SELECT scan_status::text AS s FROM file_objects WHERE id = ${id}::uuid`,
      );
      expect(row!.s).toBe('pending');
    });

    it.each(['organizations', 'org'])('accepts own %s/{organizationId}/... keys', async (p) => {
      const f = await createFile(orgA, `${p}/${orgA}/meetings/m/${randomUUID()}.webm`);
      expect(f.key.startsWith(`${p}/${orgA}/`)).toBe(true);
    });

    it.each([
      ['organizations/ of another organization', () => `organizations/${orgB}/x`],
      ['org/ of another organization', () => `org/${orgB}/x`],
      ['no prefix', () => `${orgA}/x`],
      [
        'tmp/session-chunks/ (chunk-table only)',
        () => `tmp/session-chunks/organizations/${orgA}/x`,
      ],
      ['prefix only', () => `organizations/${orgA}/`],
      ['missing slash', () => `organizations/${orgA}`],
      ['upper-case organization id', () => `organizations/${orgA.toUpperCase()}/x`],
      ['garbage', () => 'isolation-test'],
    ])('rejects a storage_key with %s', async (_label, key) => {
      await expect(createFile(orgA, key())).rejects.toThrow(
        /file_objects_storage_key_org_check|23514|check constraint/,
      );
    });

    it('cannot re-home a key into another organization by UPDATE', async () => {
      await expect(
        inOrg(orgA, (tx) =>
          tx.fileObject.update({
            where: { id: fileA },
            data: { key: `organizations/${orgB}/stolen` },
          }),
        ),
      ).rejects.toThrow(/file_objects_storage_key_org_check|23514|check constraint/);
    });

    it('checksum_sha256 must be 64 lower-case hex chars (constraint now validated)', async () => {
      const ok = 'a'.repeat(64);
      expect(
        (await createFile(orgA, `organizations/${orgA}/s/${randomUUID()}`, ok)).checksumSha256,
      ).toBe(ok);
      for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}\n`]) {
        await expect(
          createFile(orgA, `organizations/${orgA}/s/${randomUUID()}`, bad),
        ).rejects.toThrow(/file_objects_checksum_sha256_check|23514|check constraint/);
      }
      const [c] = await owner.$queryRaw<{ v: boolean }[]>`
        SELECT convalidated AS v FROM pg_constraint WHERE conname = 'file_objects_checksum_sha256_check'`;
      expect(c!.v).toBe(true);
    });
  });

  describe('consent_attestations', () => {
    it('stores an upload and a recording_session attestation; recordedAt is server time', async () => {
      const before = Date.now();
      const up = await attest(orgA, { method: 'all_parties_notified' });
      const rs = await attest(orgA, { subjectType: 'recording_session', subjectId: sessionA });
      expect(up).toMatchObject({ organizationId: orgA, subjectType: 'upload', subjectId: fileA });
      expect(rs).toMatchObject({ subjectType: 'recording_session', subjectId: sessionA });
      expect(up.recordedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      const rows = await inOrg(orgA, (tx) =>
        tx.consentAttestation.findMany({ where: { id: { in: [up.id, rs.id] } } }),
      );
      expect(rows).toHaveLength(2);
    });

    it('is invisible across organizations and with no organization context', async () => {
      const a = await attest(orgA);
      expect(await inOrg(orgB, (tx) => tx.consentAttestation.count({ where: { id: a.id } }))).toBe(
        0,
      );
      expect(await app.consentAttestation.count({ where: { id: a.id } })).toBe(0);
      const [none] = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_organization_id', '', true)`;
        return tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM consent_attestations`;
      });
      expect(none!.n).toBe(0n);
    });

    it('rejects an insert for another organization (WITH CHECK)', async () => {
      await expect(
        inOrg(orgA, (tx) =>
          tx.consentAttestation.create({
            data: {
              organizationId: orgB,
              subjectType: 'upload',
              subjectId: fileB,
              consentVersion: CURRENT_CONSENT_VERSION,
              method: 'all_parties_consented',
              attestedByUserId: userId,
              attestedAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it.each([
      ['another organization’s upload', () => ({ subjectId: fileB })],
      ['a missing upload', () => ({ subjectId: randomUUID() })],
      ['a recording session id typed as upload', () => ({ subjectId: sessionA })],
      [
        'an upload id typed as recording_session',
        () => ({ subjectType: 'recording_session' as const, subjectId: fileA }),
      ],
    ])('rejects a subject that is %s', async (_label, data) => {
      await expect(
        attest(orgA, data()).catch((e) => Promise.reject(new Error(dbError(e)))),
      ).rejects.toThrow(/not found in organization|23503|foreign key/i);
    });

    it('rejects another organization’s subject even for the owner role', async () => {
      await expect(
        attest(orgA, { subjectId: fileB }, owner).catch((e) =>
          Promise.reject(new Error(dbError(e))),
        ),
      ).rejects.toThrow(/not found in organization|P2003|23503/);
    });

    it.each(['', ' 2026-10', '2026 10', '-2026', 'v'.repeat(33), '2026/10', 'ünicode'])(
      'rejects consent_version %j',
      async (consentVersion) => {
        await expect(attest(orgA, { consentVersion })).rejects.toThrow(
          /consent_attestations_consent_version_check|23514|check constraint/,
        );
      },
    );

    it('accepts versions up to 32 chars from the contract pattern', async () => {
      for (const consentVersion of ['2026-10', 'v1.2_rc-3', 'a'.repeat(32)]) {
        expect((await attest(orgA, { consentVersion })).consentVersion).toBe(consentVersion);
      }
    });

    it(`rejects attestedAt more than ${CONSENT_ATTESTATION_MAX_SKEW_SECONDS}s ahead of the server`, async () => {
      const ahead = new Date(Date.now() + (CONSENT_ATTESTATION_MAX_SKEW_SECONDS + 60) * 1000);
      await expect(attest(orgA, { attestedAt: ahead })).rejects.toThrow(
        /consent_attestations_attested_at_skew_check|23514|check constraint/,
      );
      const slightlyAhead = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 86_400_000);
      expect((await attest(orgA, { attestedAt: slightlyAhead })).id).toBeTruthy();
      expect((await attest(orgA, { attestedAt: past })).id).toBeTruthy();
    });

    it('the app role holds only SELECT and INSERT', async () => {
      const [p] = await owner.$queryRaw<Record<string, boolean>[]>`
        SELECT has_table_privilege('meetops_app', 'consent_attestations', 'SELECT') AS s,
               has_table_privilege('meetops_app', 'consent_attestations', 'INSERT') AS i,
               has_table_privilege('meetops_app', 'consent_attestations', 'UPDATE') AS u,
               has_table_privilege('meetops_app', 'consent_attestations', 'DELETE') AS d,
               has_table_privilege('meetops_app', 'consent_attestations', 'TRUNCATE') AS t`;
      expect(p).toEqual({ s: true, i: true, u: false, d: false, t: false });
      const [rls] = await owner.$queryRaw<{ e: boolean; f: boolean }[]>`
        SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = 'consent_attestations'`;
      expect(rls).toEqual({ e: true, f: true });
    });

    it('UPDATE and DELETE are refused for the app, even with the maintenance setting', async () => {
      const a = await attest(orgA);
      for (const sql of [
        `UPDATE consent_attestations SET method = 'all_parties_notified' WHERE id = $1::uuid`,
        `DELETE FROM consent_attestations WHERE id = $1::uuid`,
        `TRUNCATE consent_attestations`,
      ]) {
        await expect(
          inOrg(orgA, async (tx) => {
            await tx.$executeRaw`SELECT set_config('meetops.consent_maintenance', 'on', true)`;
            return sql.includes('$1') ? tx.$executeRawUnsafe(sql, a.id) : tx.$executeRawUnsafe(sql);
          }),
        ).rejects.toThrow(/permission denied/);
      }
      expect(await inOrg(orgA, (tx) => tx.consentAttestation.count({ where: { id: a.id } }))).toBe(
        1,
      );
    });

    it('UPDATE, DELETE and TRUNCATE raise append-only for the owner role (RLS off for the check)', async () => {
      const a = await attest(orgA);
      const asOwnerNoForce = (sql: string) =>
        owner.$transaction(async (tx) => {
          // NO FORCE inside a rolled-back transaction so the row is visible and the trigger, not RLS, decides.
          await tx.$executeRawUnsafe(
            `ALTER TABLE consent_attestations NO FORCE ROW LEVEL SECURITY`,
          );
          return sql.includes('$1') ? tx.$executeRawUnsafe(sql, a.id) : tx.$executeRawUnsafe(sql);
        });
      for (const sql of [
        `UPDATE consent_attestations SET consent_version = 'x' WHERE id = $1::uuid`,
        `DELETE FROM consent_attestations WHERE id = $1::uuid`,
        `TRUNCATE consent_attestations`,
      ]) {
        await expect(asOwnerNoForce(sql)).rejects.toThrow(/append-only/);
      }
      const [still] = await owner.$queryRaw<{ f: boolean }[]>`
        SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'consent_attestations'`;
      expect(still!.f).toBe(true);
      expect(await inOrg(orgA, (tx) => tx.consentAttestation.count({ where: { id: a.id } }))).toBe(
        1,
      );
    });

    it('an organization or attesting user with attestations cannot be hard-deleted (RESTRICT)', async () => {
      await attest(orgA);
      await expect(owner.organization.delete({ where: { id: orgA } })).rejects.toThrow(
        /Foreign key constraint|consent_attestations|P2003|23503/,
      );
      await expect(owner.user.delete({ where: { id: userId } })).rejects.toThrow(
        /Foreign key constraint|consent_attestations|P2003|23503/,
      );
    });
  });
});

describe.skipIf(!ADMIN_URL)(`${MIGRATION} on a scratch database (live)`, () => {
  const name = `meetops_db3_scratch_${randomUUID().replace(/-/g, '')}`;
  const scratchUrl = (() => {
    const u = new URL(ADMIN_URL ?? 'postgresql://x/y');
    u.pathname = `/${name}`;
    return u.toString();
  })();
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
  const work = mkdtempSync(join(tmpdir(), 'db3-scratch-'));
  // The URL travels by environment variable, never on a command line or in a file.
  const schemaFile = join(work, 'schema.prisma');
  writeFileSync(
    schemaFile,
    'datasource db {\n  provider = "postgresql"\n  url      = env("DB3_SCRATCH_URL")\n}\n',
  );
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const sqlOf = (dir: string) => readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');

  /** Run a script as ONE command (as prisma migrate does), so a failure rolls the whole script back. */
  function execute(sql: string) {
    const file = join(work, `${randomUUID()}.sql`);
    writeFileSync(file, sql);
    const r = spawnSync(
      process.execPath,
      [PRISMA_CLI, 'db', 'execute', '--schema', schemaFile, '--file', file],
      { env: { ...process.env, DB3_SCRATCH_URL: scratchUrl }, encoding: 'utf8', timeout: 240_000 },
    );
    return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  }
  const typeExists = async () => {
    const [r] = await scratch.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_type WHERE typname = 'FileScanStatus'`;
    return r!.n > 0n;
  };
  const org = randomUUID();
  const badKeyId = randomUUID();
  const badShaId = randomUUID();

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const prior = dirs.filter((d) => d < MIGRATION);
    expect(prior.length).toBeGreaterThan(20);
    const r = execute(prior.map(sqlOf).join('\n'));
    expect(r.ok, r.out).toBe(true);
    await scratch.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ('${org}', 'S', 's-${org}', now())`,
    );
    const ins = (id: string, key: string, sha: string | null) =>
      scratch.$executeRawUnsafe(
        `INSERT INTO file_objects (id, org_id, bucket, storage_key, mime_type, checksum_sha256, updated_at)
         VALUES ('${id}', '${org}', 'b', $1, 'audio/webm', $2, now())`,
        key,
        sha,
      );
    await ins(randomUUID(), `organizations/${org}/ok.webm`, 'b'.repeat(64));
    await ins(randomUUID(), `org/${org}/legacy-ok.webm`, null);
    // A key outside its organization's prefix (allowed before DB-3).
    await ins(badKeyId, `organizations/${randomUUID()}/foreign.webm`, null);
    // A legacy non-hex checksum written before the NOT VALID CHECK existed.
    await scratch.$transaction([
      scratch.$executeRawUnsafe(
        `ALTER TABLE file_objects DROP CONSTRAINT file_objects_checksum_sha256_check`,
      ),
      scratch.$executeRawUnsafe(
        `INSERT INTO file_objects (id, org_id, bucket, storage_key, mime_type, checksum_sha256, updated_at)
         VALUES ('${badShaId}', '${org}', 'b', 'org/${org}/sha.webm', 'audio/webm', 'NOT-HEX', now())`,
      ),
      scratch.$executeRawUnsafe(`ALTER TABLE file_objects ADD CONSTRAINT file_objects_checksum_sha256_check
        CHECK ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$') NOT VALID`),
    ]);
  }, 300_000);

  afterAll(async () => {
    await scratch.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    rmSync(work, { recursive: true, force: true });
  });

  it('fails loudly, naming both counts and sample ids, and applies nothing', async () => {
    const r = execute(sqlOf(MIGRATION));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(
      /consent_scan_keycheck preflight failed: 1 file_objects row\(s\) with a storage_key/,
    );
    expect(r.out).toContain(badKeyId);
    expect(r.out).toMatch(/1 row\(s\) with a non-hex checksum_sha256/);
    expect(r.out).toContain(badShaId);
    expect(await typeExists()).toBe(false);
  }, 300_000);

  it('still fails while one violation remains', async () => {
    await scratch.$executeRawUnsafe(
      `UPDATE file_objects SET storage_key = 'organizations/${org}/moved.webm' WHERE id = '${badKeyId}'`,
    );
    const r = execute(sqlOf(MIGRATION));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(
      /preflight failed: 0 file_objects row\(s\)[\s\S]*1 row\(s\) with a non-hex/,
    );
    expect(await typeExists()).toBe(false);
  }, 300_000);

  it('applies once the rows are fixed; existing rows get scan_status pending', async () => {
    await scratch.$executeRawUnsafe(
      `UPDATE file_objects SET checksum_sha256 = NULL WHERE id = '${badShaId}'`,
    );
    const r = execute(sqlOf(MIGRATION));
    expect(r.ok, r.out).toBe(true);
    const rows = await scratch.$queryRaw<{ s: string; n: bigint }[]>`
      SELECT scan_status::text AS s, count(*) AS n FROM file_objects GROUP BY 1`;
    expect(rows).toEqual([{ s: 'pending', n: 4n }]);
    const [c] = await scratch.$queryRaw<{ v: boolean }[]>`
      SELECT bool_and(convalidated) AS v FROM pg_constraint
      WHERE conname IN ('file_objects_checksum_sha256_check', 'file_objects_storage_key_org_check')`;
    expect(c!.v).toBe(true);
  }, 300_000);
});
