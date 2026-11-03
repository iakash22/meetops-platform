/**
 * #350 L3: PrismaSemanticSearch repository contract over live Postgres + pgvector (forced RLS, meetops_app role).
 * The mocked suite (semantic-search-prisma.test.ts) only sees the SQL text. This one runs it and checks:
 * cosine ranking and score, the result mapping, the limit clamp, model and kind filters, and that soft-deleted
 * reports and meetings are excluded. Tenant isolation is covered by semantic-search.live.test.ts.
 * Skipped unless TEST_DATABASE_URL (meetops_app) and TEST_ADMIN_DATABASE_URL (owner/migrator, to create the org) are
 * set. TEST_OWNER_DATABASE_URL is accepted as the admin URL too, as in the other semantic live suite.
 *   TEST_DATABASE_URL=... TEST_ADMIN_DATABASE_URL=... pnpm --filter @meetops/api exec vitest run \
 *     test/semantic-search.repository.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import {
  PrismaSemanticSearch,
  SEMANTIC_EMBEDDING_DIMS,
  toVectorLiteral,
} from '../src/modules/search/semantic.js';

const url = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? process.env.TEST_OWNER_DATABASE_URL;
const MODEL = 'live-repo-embed';
const OTHER_MODEL = 'live-repo-embed-v2';

/** Unit-ish vector from a few non-zero coordinates (the rest 0). */
const vec = (coords: Record<number, number>) =>
  Array.from({ length: SEMANTIC_EMBEDDING_DIMS }, (_, i) => coords[i] ?? 0);
const Q = vec({ 0: 1 });

describe.skipIf(!url || !adminUrl)(
  'Phase 7 PrismaSemanticSearch repository (live)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    const org = randomUUID();
    const ids: Record<string, { report: string; meeting: string }> = {};

    async function seed(
      key: string,
      v: number[],
      opts: { model?: string; reportDeleted?: boolean; meetingDeleted?: boolean } = {},
    ) {
      await withOrganizationContext(
        org,
        async (tx) => {
          const meeting = await tx.meeting.create({
            data: {
              organizationId: org,
              title: `${key} meeting`,
              ...(opts.meetingDeleted ? { deletedAt: new Date() } : {}),
            },
          });
          const report = await tx.report.create({
            data: {
              organizationId: org,
              meetingId: meeting.id,
              title: `${key} report`,
              summary: `${key} summary`,
              ...(opts.reportDeleted ? { deletedAt: new Date() } : {}),
            },
          });
          ids[key] = { report: report.id, meeting: meeting.id };
          await tx.$executeRawUnsafe(
            `INSERT INTO meeting_embeddings
             (id, org_id, meeting_id, source_kind, report_id, model, content_sha256, embedding, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'summary', $3::uuid, $4,
                   encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $5::vector, now())`,
            org,
            meeting.id,
            report.id,
            opts.model ?? MODEL,
            toVectorLiteral(v),
          );
        },
        { client: db },
      );
    }

    const search = (input: Partial<Parameters<PrismaSemanticSearch['search']>[1]> = {}) =>
      new PrismaSemanticSearch(db).search(org, {
        vector: Q,
        model: MODEL,
        kinds: ['summary', 'transcript'],
        limit: 20,
        ...input,
      });

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: url! });
      const admin = createPrismaClient({ databaseUrl: adminUrl! });
      await admin.organization.create({
        data: { id: org, name: 'Semantic repo', slug: `semantic-repo-${org.slice(0, 8)}` },
      });
      await admin.$disconnect();
      // Inserted out of rank order so ORDER BY (not insertion order) is what the test sees.
      await seed('far', vec({ 0: 0.01, 1: 1 }));
      await seed('exact', vec({ 0: 1 }));
      await seed('near', vec({ 0: 1, 1: 1 }));
      await seed('otherModel', vec({ 0: 1 }), { model: OTHER_MODEL });
      await seed('deletedReport', vec({ 0: 1 }), { reportDeleted: true });
      await seed('deletedMeeting', vec({ 0: 1 }), { meetingDeleted: true });
    });
    afterAll(async () => db?.$disconnect());

    it('ranks by cosine distance and maps rows to results', async () => {
      const rows = await search();
      expect(rows.map((r) => r.id)).toEqual([ids.exact!.report, ids.near!.report, ids.far!.report]);
      const [exact, near, far] = rows;
      expect(exact!.score).toBeCloseTo(1, 5);
      expect(near!.score).toBeCloseTo(Math.SQRT1_2, 5);
      expect(far!.score).toBeCloseTo(0.01, 3);
      for (const r of rows) {
        expect(r.kind).toBe('summary');
        expect(r.score).toBeGreaterThanOrEqual(-1);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r).not.toHaveProperty('startMs');
        expect(Number.isNaN(Date.parse(r.occurredAt))).toBe(false);
      }
      expect(exact).toMatchObject({
        meetingId: ids.exact!.meeting,
        title: 'exact report',
        snippet: 'exact report exact summary',
      });
    });

    it('clamps the limit to 1..20', async () => {
      expect((await search({ limit: 2 })).map((r) => r.id)).toEqual([
        ids.exact!.report,
        ids.near!.report,
      ]);
      expect(await search({ limit: 0 })).toHaveLength(1);
      expect(await search({ limit: -5 })).toHaveLength(1);
      expect(await search({ limit: 1e9 })).toHaveLength(3);
      expect(await search({ limit: Number.NaN })).toHaveLength(3);
    });

    it('filters by embedding model', async () => {
      expect((await search({ model: OTHER_MODEL })).map((r) => r.id)).toEqual([
        ids.otherModel!.report,
      ]);
      expect(await search({ model: 'never-used' })).toEqual([]);
    });

    it('filters by kind', async () => {
      expect(await search({ kinds: ['transcript'] })).toEqual([]);
      expect(await search({ kinds: ['summary'] })).toHaveLength(3);
    });

    it('excludes soft-deleted reports and meetings', async () => {
      const got = new Set((await search()).map((r) => r.id));
      expect(got.has(ids.deletedReport!.report)).toBe(false);
      expect(got.has(ids.deletedMeeting!.report)).toBe(false);
    });

    it('runs under the 2 s statement timeout and leaves no session setting behind', async () => {
      await search();
      const t = await db.$queryRawUnsafe<{ t: string }[]>(`SHOW statement_timeout`);
      expect(t[0]!.t).not.toBe('2s');
    });
  },
);
