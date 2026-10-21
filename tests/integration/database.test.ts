import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { isDockerAvailable } from '../support/env.js';
import { applyMigrations, canSeed, dbPackageDir, hasMigrations } from '../support/db-package.js';
import { createRng } from '../factories/rng.js';

const docker = isDockerAvailable();
const schema = hasMigrations();
if (!docker) console.warn('[integration/db] Docker not available: skipping');
else if (!schema)
  console.warn(
    `[integration/db] no Prisma migrations under ${dbPackageDir}: skipping (set QA_DB_PACKAGE_DIR)`,
  );

const SEED_ORG = '00000000-0000-4000-8000-000000000001';
const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0b000000-0000-4000-8000-00000000000b';
const DIM = 1536;

/** Deterministic unit-ish vector so similarity results are reproducible. */
function vec(seed: number): string {
  const rng = createRng(seed);
  return `[${Array.from({ length: DIM }, () => (rng.next() * 2 - 1).toFixed(6)).join(',')}]`;
}

describe.skipIf(!docker || !schema)(
  'integration: database schema (pgvector, Prisma migrations)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: pg.Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(
        process.env.QA_POSTGRES_IMAGE ?? 'pgvector/pgvector:pg16',
      ).start();
      db = new pg.Client({ connectionString: container.getConnectionUri() });
      await db.connect();
    });

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    });

    it('applies every migration', async () => {
      await applyMigrations(container.getConnectionUri(), db);
      const { rows } = await db.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      expect(rows).toHaveLength(1);
      const tables = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('organizations','meetings','transcripts','transcript_segments')",
      );
      expect(tables.rows[0]?.n).toBe('4');
    });

    it.skipIf(!canSeed())(
      'runs prisma/seed.ts and is idempotent',
      () => {
        const env = { ...process.env, DATABASE_URL: container.getConnectionUri() };
        const tsx = join(dbPackageDir, 'node_modules/.bin/tsx');
        for (let i = 0; i < 2; i++)
          execFileSync(tsx, ['prisma/seed.ts'], {
            cwd: dbPackageDir,
            env,
            stdio: 'pipe',
            timeout: 120_000,
          });
        return db
          .query('SELECT slug FROM organizations WHERE id = $1', [SEED_ORG])
          .then(({ rows }) => {
            expect(rows).toEqual([{ slug: 'demo' }]);
          });
      },
      180_000,
    );

    describe('organization isolation (query-level, no RLS yet)', () => {
      beforeAll(async () => {
        for (const [id, slug] of [
          [ORG_A, 'qa-a'],
          [ORG_B, 'qa-b'],
        ] as const) {
          await db.query(
            'INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())',
            [id, slug, slug],
          );
          await db.query(
            'INSERT INTO meetings (id, org_id, title, updated_at) VALUES (gen_random_uuid(), $1, $2, now()), (gen_random_uuid(), $1, $3, now())',
            [id, `${slug} sync`, `${slug} secret-${slug}`],
          );
        }
      });

      it('org-scoped meeting list never contains the other organization', async () => {
        const a = await db.query<{ org_id: string; title: string }>(
          'SELECT org_id, title FROM meetings WHERE org_id = $1',
          [ORG_A],
        );
        expect(a.rows).toHaveLength(2);
        expect(a.rows.every((r) => r.org_id === ORG_A)).toBe(true);
        expect(a.rows.some((r) => r.title.includes('qa-b'))).toBe(false);
      });

      it('[XT-13 analogue] full-text match on a B-only term returns nothing for A', async () => {
        const { rows } = await db.query(
          'SELECT id FROM meetings WHERE org_id = $1 AND title ILIKE $2',
          [ORG_A, '%secret-qa-b%'],
        );
        expect(rows).toHaveLength(0);
      });

      it('[XT-01 analogue] fetching a B id under A scope returns no row', async () => {
        const b = await db.query<{ id: string }>(
          'SELECT id FROM meetings WHERE org_id = $1 LIMIT 1',
          [ORG_B],
        );
        const { rows } = await db.query('SELECT id FROM meetings WHERE id = $1 AND org_id = $2', [
          b.rows[0]?.id,
          ORG_A,
        ]);
        expect(rows).toHaveLength(0);
      });
    });

    describe('pgvector: transcript_segments.embedding', () => {
      const segIds: Record<string, string> = {};

      beforeAll(async () => {
        for (const org of [ORG_A, ORG_B]) {
          const m = await db.query<{ id: string }>(
            'SELECT id FROM meetings WHERE org_id = $1 LIMIT 1',
            [org],
          );
          const t = await db.query<{ id: string }>(
            'INSERT INTO transcripts (id, org_id, meeting_id, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id',
            [org, m.rows[0]?.id],
          );
          for (const [seq, seed] of [
            [0, 1],
            [1, 2],
            [2, 3],
          ] as const) {
            const s = await db.query<{ id: string }>(
              `INSERT INTO transcript_segments (id, org_id, transcript_id, sequence, start_ms, end_ms, text, embedding, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 0, 1000, $4, $5::vector, now()) RETURNING id`,
              [org, t.rows[0]?.id, seq, `seg ${seed}`, vec(org === ORG_A ? seed : seed + 100)],
            );
            segIds[`${org}:${seed}`] = s.rows[0]!.id;
          }
        }
        // B holds an exact copy of the query vector: the nearest neighbour overall.
        await db.query('UPDATE transcript_segments SET embedding = $1::vector WHERE id = $2', [
          vec(2),
          segIds[`${ORG_B}:1`],
        ]);
      });

      it('stores 1536-dim vectors', async () => {
        const { rows } = await db.query<{ d: number }>(
          'SELECT vector_dims(embedding) AS d FROM transcript_segments WHERE embedding IS NOT NULL LIMIT 1',
        );
        expect(rows[0]?.d).toBe(DIM);
      });

      it('cosine similarity returns the closest segment first', async () => {
        const { rows } = await db.query<{ id: string; dist: number }>(
          'SELECT id, embedding <=> $1::vector AS dist FROM transcript_segments WHERE org_id = $2 ORDER BY dist LIMIT 3',
          [vec(2), ORG_A],
        );
        expect(rows[0]?.id).toBe(segIds[`${ORG_A}:2`]);
        expect(rows[0]?.dist).toBeCloseTo(0, 5);
        expect(rows[1]!.dist).toBeGreaterThan(rows[0]!.dist);
      });

      it('[XT-14 analogue] org-scoped vector search never returns B chunks, even an exact match', async () => {
        const { rows } = await db.query<{ org_id: string }>(
          'SELECT org_id FROM transcript_segments WHERE org_id = $2 ORDER BY embedding <=> $1::vector LIMIT 10',
          [vec(2), ORG_A],
        );
        expect(rows.length).toBe(3);
        expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
      });
    });

    // RLS (XT-26..XT-29) lives in integration/rls.test.ts.
  },
);
