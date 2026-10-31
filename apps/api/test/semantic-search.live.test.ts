/**
 * Phase 7 semantic search over live Postgres + pgvector (forced RLS, meetops_app role). Two organizations embed
 * the SAME vector; SEMANTIC_SEARCH_SQL run for org B must never return org A's rows, and vice versa, both through
 * PrismaSemanticSearch and with the raw query given another org's id while org B's context is set.
 * Skipped unless TEST_DATABASE_URL (meetops_app) and TEST_OWNER_DATABASE_URL (migrator, to create orgs) are set:
 *   TEST_DATABASE_URL=... TEST_OWNER_DATABASE_URL=... pnpm --filter @meetops/api exec vitest run \
 *     test/semantic-search.live.test.ts
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
  SEMANTIC_SEARCH_SQL,
  toVectorLiteral,
} from '../src/modules/search/semantic.js';

const url = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL;
const MODEL = 'live-test-embed';
const VEC = Array.from({ length: SEMANTIC_EMBEDDING_DIMS }, (_, i) => (i % 7) / 7 + 0.01);

describe.skipIf(!url || !ownerUrl)(
  'Phase 7 semantic search tenant isolation (live)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    const orgA = randomUUID();
    const orgB = randomUUID();
    const reportOf = new Map<string, string>();

    async function seedOrg(org: string, label: string) {
      await withOrganizationContext(
        org,
        async (tx) => {
          const meeting = await tx.meeting.create({
            data: { organizationId: org, title: `${label} semantic planning` },
          });
          const report = await tx.report.create({
            data: {
              organizationId: org,
              meetingId: meeting.id,
              title: `${label} summary`,
              summary: 'x',
            },
          });
          reportOf.set(org, report.id);
          await tx.$executeRawUnsafe(
            `INSERT INTO meeting_embeddings
             (id, org_id, meeting_id, source_kind, report_id, model, content_sha256, embedding, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'summary', $3::uuid, $4,
                   encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $5::vector, now())`,
            org,
            meeting.id,
            report.id,
            MODEL,
            toVectorLiteral(VEC),
          );
        },
        { client: db },
      );
    }

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: url! });
      const o = createPrismaClient({ databaseUrl: ownerUrl! });
      for (const [id, n] of [
        [orgA, 'a'],
        [orgB, 'b'],
      ] as const)
        await o.organization.create({
          data: { id, name: `Semantic ${n}`, slug: `semantic-${n}-${id.slice(0, 8)}` },
        });
      await o.$disconnect();
      await seedOrg(orgA, 'Alpha');
      await seedOrg(orgB, 'Beta');
    });
    afterAll(async () => db?.$disconnect());

    it('returns only the caller org embeddings for an identical vector', async () => {
      const s = new PrismaSemanticSearch(db);
      const input = {
        vector: VEC,
        model: MODEL,
        kinds: ['summary', 'transcript'] as ('summary' | 'transcript')[],
        limit: 20,
      };
      const b = await s.search(orgB, input);
      expect(b.map((r) => r.id)).toEqual([reportOf.get(orgB)]);
      expect(b.every((r) => !r.title.includes('Alpha'))).toBe(true);
      const a = await s.search(orgA, input);
      expect(a.map((r) => r.id)).toEqual([reportOf.get(orgA)]);
    });

    it('raw SEMANTIC_SEARCH_SQL with org A id under org B context returns nothing (RLS)', async () => {
      const rows = await withOrganizationContext(
        orgB,
        (tx) =>
          tx.$queryRawUnsafe<{ id: string }[]>(
            SEMANTIC_SEARCH_SQL,
            orgA,
            MODEL,
            toVectorLiteral(VEC),
            ['summary', 'transcript'],
            20,
          ),
        { client: db },
      );
      expect(rows).toEqual([]);
      const visible = await withOrganizationContext(
        orgB,
        (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM meeting_embeddings`),
        { client: db },
      );
      expect(visible[0]!.n).toBe(1);
    });
  },
);
