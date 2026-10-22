import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { isDockerAvailable } from '../support/env.js';
import {
  applyDatamodelPlusRls,
  applyMigrations,
  dbPackageDir,
  hasRlsMigration,
  insertTranscript,
} from '../support/db-package.js';

/*
 * Database-level XT cases using DB's withOrgContext (PR #25) the way the API will: a
 * Prisma client connected as a meetops_app login role, every query inside
 * withOrgContext(orgId, tx => ...). Org B data must be invisible and unwritable from org A.
 * The HTTP forms of these cases (GET /meetings/{id} etc.) wait on Backend endpoints.
 * Set QA_DB_PACKAGE_DIR to PR #25's packages/database (with its deps installed).
 * QA_RLS_SCHEMA=datamodel works around DB-BUG-1 (broken migration chain).
 */
const docker = isDockerAvailable();
const hasWithOrgContext =
  hasRlsMigration() &&
  existsSync(join(dbPackageDir, 'src/tenant.ts')) &&
  existsSync(join(dbPackageDir, 'node_modules/@prisma/client'));
if (docker && !hasWithOrgContext)
  console.warn(
    `[integration/xt-db] no withOrgContext/RLS under ${dbPackageDir}: skipping (set QA_DB_PACKAGE_DIR)`,
  );
// Prisma field for the tenant column: `orgId` (PR #6/#25) or `organizationId` (PR #35).
const schemaText = existsSync(join(dbPackageDir, 'prisma/schema.prisma'))
  ? readFileSync(join(dbPackageDir, 'prisma/schema.prisma'), 'utf8')
  : '';
const ORG: 'orgId' | 'organizationId' = /model Meeting \{[^}]*\borganizationId\b/.test(schemaText)
  ? 'organizationId'
  : 'orgId';
const schemaMode = process.env.QA_RLS_SCHEMA === 'datamodel' ? 'datamodel' : 'migrations';

type Tx = {
  meeting: {
    findUnique(a: object): Promise<{ id: string; title: string } | null>;
    findMany(a?: object): Promise<({ id: string } & Record<string, unknown>)[]>;
    updateMany(a: object): Promise<{ count: number }>;
    deleteMany(a: object): Promise<{ count: number }>;
  };
  task: { create(a: object): Promise<unknown>; count(a?: object): Promise<number> };
  $queryRawUnsafe<T>(sql: string, ...v: unknown[]): Promise<T>;
};
type Db = {
  createPrismaClient(o: { databaseUrl: string }): { $disconnect(): Promise<void> };
  withOrgContext<T>(orgId: string, fn: (tx: Tx) => Promise<T>, o: { client: unknown }): Promise<T>;
};

const DIM = 1536;
const unitVec = (i: number) =>
  `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(',')}]`;

describe.skipIf(!docker || !hasWithOrgContext)(
  `XT via withOrgContext (PR #25, schema via ${schemaMode})`,
  () => {
    let container: StartedPostgreSqlContainer;
    let owner: pg.Client;
    let db: Db;
    let client: { $disconnect(): Promise<void> };
    const orgA = randomUUID();
    const orgB = randomUUID();
    const meetA = randomUUID();
    const meetB = randomUUID();
    const asA = <T>(fn: (tx: Tx) => Promise<T>) => db.withOrgContext(orgA, fn, { client });

    beforeAll(async () => {
      container = await new PostgreSqlContainer(
        process.env.QA_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16',
      ).start();
      owner = new pg.Client({ connectionString: container.getConnectionUri() });
      await owner.connect();
      if (schemaMode === 'datamodel') await applyDatamodelPlusRls(owner);
      else await applyMigrations(container.getConnectionUri(), owner);

      await owner.query(
        "CREATE ROLE qa_xt_app LOGIN PASSWORD 'qa-only-not-a-secret' IN ROLE meetops_app",
      );
      for (const [org, meet, slug] of [
        [orgA, meetA, 'xt-a'],
        [orgB, meetB, 'xt-b'],
      ] as const) {
        await owner.query(
          'INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())',
          [org, slug],
        );
        await owner.query(
          'INSERT INTO meetings (id, org_id, title, updated_at) VALUES ($1, $2, $3, now())',
          [meet, org, `${slug} unique-term-${slug}`],
        );
        const t = { rows: [{ id: await insertTranscript(owner, org, meet) }] };
        await owner.query(
          `INSERT INTO transcript_segments (id, org_id, transcript_id, sequence, start_ms, end_ms, text, embedding, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 0, 0, 1, $3, $4::vector, now())`,
          [org, t.rows[0]?.id, `${slug} segment`, unitVec(org === orgA ? 1 : 0)],
        );
      }

      db = (await import(pathToFileURL(join(dbPackageDir, 'src/index.ts')).href)) as Db;
      const url = new URL(container.getConnectionUri());
      url.username = 'qa_xt_app';
      url.password = 'qa-only-not-a-secret';
      client = db.createPrismaClient({ databaseUrl: url.toString() });
    }, 300_000);

    afterAll(async () => {
      await client?.$disconnect();
      await owner?.end();
      await container?.stop();
    });

    it('[XT-01] A cannot read a B meeting by id', async () => {
      expect(await asA((tx) => tx.meeting.findUnique({ where: { id: meetB } }))).toBeNull();
      expect(await asA((tx) => tx.meeting.findUnique({ where: { id: meetA } }))).not.toBeNull();
    });

    it('[XT-02] A cannot update a B meeting; B row unchanged', async () => {
      const r = await asA((tx) =>
        tx.meeting.updateMany({ where: { id: meetB }, data: { title: 'pwned' } }),
      );
      expect(r.count).toBe(0);
      const { rows } = await owner.query<{ title: string }>(
        'SELECT title FROM meetings WHERE id = $1',
        [meetB],
      );
      expect(rows[0]?.title).toBe('xt-b unique-term-xt-b');
    });

    it('[XT-03] A cannot delete a B meeting; B row still exists', async () => {
      const r = await asA((tx) => tx.meeting.deleteMany({ where: { id: meetB } }));
      expect(r.count).toBe(0);
      const { rows } = await owner.query('SELECT 1 FROM meetings WHERE id = $1', [meetB]);
      expect(rows).toHaveLength(1);
    });

    it('[XT-04] listing as A, even filtering by orgId = B, returns only A rows', async () => {
      const all = await asA((tx) => tx.meeting.findMany());
      expect(all.map((m) => m[ORG])).toEqual([orgA]);
      expect(await asA((tx) => tx.meeting.findMany({ where: { [ORG]: orgB } }))).toEqual([]);
    });

    it('[XT-10] A cannot create a task referencing a B meeting; no row created', async () => {
      const err = await asA((tx) =>
        tx.task.create({ data: { [ORG]: orgA, title: 't', meetingId: meetB } }),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      // Must be rejected by the database, not by Prisma input validation (wrong field names).
      expect((err as Error).constructor.name).not.toBe('PrismaClientValidationError');
      const { rows } = await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tasks WHERE meeting_id = $1',
        [meetB],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('[XT-13] text search for a B-only term returns 0 results as A', async () => {
      const r = await asA((tx) =>
        tx.$queryRawUnsafe<unknown[]>(
          "SELECT id FROM meetings WHERE title ILIKE '%unique-term-xt-b%'",
        ),
      );
      expect(r).toEqual([]);
    });

    it('[XT-14] vector search with B chunk text vector returns no B chunks as A', async () => {
      const r = await asA((tx) =>
        tx.$queryRawUnsafe<{ org_id: string }[]>(
          'SELECT org_id::text FROM transcript_segments WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 10',
          unitVec(0),
        ),
      );
      expect(r.length).toBeGreaterThan(0);
      expect(r.every((x) => x.org_id === orgA)).toBe(true);
    });

    it('withOrgContext rejects a non-UUID org id before touching the DB', async () => {
      await expect(db.withOrgContext("x' OR 1=1 --", async () => 1, { client })).rejects.toThrow(
        /UUID/,
      );
    });
  },
);
