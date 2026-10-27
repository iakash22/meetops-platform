/**
 * Live tests for AI usage counters, AI idempotency, AI organization config and chunked transcripts:
 * repository behavior, single-winner concurrency, no done-chunk downgrade, and RLS isolation of the
 * new tenant tables. Runs as meetops_app (forced RLS). Skipped unless RLS_TEST_APP_URL and
 * RLS_TEST_OWNER_URL are set against a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import {
  createAiIdempotencyRepository,
  createAiUsageCounterRepository,
  createTranscriptRepository,
  TRANSCRIPT_CHUNK_ERROR_MAX,
} from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('AI usage + chunked transcripts (live)', () => {
  const app = new PrismaClient({
    datasources: {
      db: {
        url: `${APP_URL ?? ''}${(APP_URL ?? '').includes('?') ? '&' : '?'}connection_limit=12`,
      },
    },
  });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const transcripts = createTranscriptRepository({ client: app });
  const usage = createAiUsageCounterRepository({ client: app });
  const idem = createAiIdempotencyRepository({ client: app });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const transcriptOf = new Map<string, string>();

  async function makeTranscript(organizationId: string): Promise<string> {
    return runWithOrganizationContext(owner, organizationId, async (tx) => {
      const meeting = await tx.meeting.create({ data: { organizationId, title: 'ai test' } });
      const file = await tx.fileObject.create({
        data: {
          organizationId,
          meetingId: meeting.id,
          kind: 'raw',
          status: 'ready',
          bucket: 'b',
          key: `org/${organizationId}/meetings/${meeting.id}/recordings/r.webm`,
          mimeType: 'audio/webm',
        },
      });
      const rec = await tx.recording.create({
        data: { organizationId, meetingId: meeting.id, fileObjectId: file.id, status: 'ready' },
      });
      const t = await tx.transcript.create({
        data: { organizationId, meetingId: meeting.id, recordingId: rec.id, provider: 'deepgram' },
      });
      return t.id;
    });
  }

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'AI A', slug: `ai-a-${orgA}` },
        { id: orgB, name: 'AI B', slug: `ai-b-${orgB}` },
      ],
    });
    transcriptOf.set(orgA, await makeTranscript(orgA));
    transcriptOf.set(orgB, await makeTranscript(orgB));
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  describe('TranscriptRepository', () => {
    it('upsertChunk inserts and updates; listChunks orders by chunkIndex', async () => {
      const transcriptId = transcriptOf.get(orgA)!;
      for (const i of [2, 0, 1]) {
        const r = await transcripts.upsertChunk(orgA, {
          transcriptId,
          chunkIndex: i,
          startMs: i * 1000,
          endMs: i * 1000 + 1000,
          provider: 'deepgram',
        });
        expect(r.applied).toBe(true);
        expect(r.chunk.organizationId).toBe(orgA);
      }
      const again = await transcripts.upsertChunk(orgA, {
        transcriptId,
        chunkIndex: 1,
        startMs: 1000,
        endMs: 2500,
        provider: 'deepgram',
        status: 'processing',
      });
      expect(again.applied).toBe(true);
      expect(again.chunk.endMs).toBe(2500);
      const list = await transcripts.listChunks(orgA, transcriptId);
      expect(list.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    });

    it('markChunk increments attemptCount and truncates the error code to 500 chars', async () => {
      const transcriptId = transcriptOf.get(orgA)!;
      const a = await transcripts.markChunk(orgA, {
        transcriptId,
        chunkIndex: 0,
        status: 'failed',
        error: 'E'.repeat(2000),
      });
      expect(a?.attemptCount).toBe(1);
      expect(a?.error?.length).toBe(TRANSCRIPT_CHUNK_ERROR_MAX);
      const b = await transcripts.markChunk(orgA, {
        transcriptId,
        chunkIndex: 0,
        status: 'done',
        text: 'hello',
        segments: [{ startMs: 0, endMs: 900, text: 'hello' }],
        error: null,
      });
      expect(b?.attemptCount).toBe(2);
      expect(b?.status).toBe('done');
      expect(b?.error).toBeNull();
    });

    it('error column itself rejects > 500 chars (VARCHAR(500))', async () => {
      const transcriptId = transcriptOf.get(orgA)!;
      await expect(
        runWithOrganizationContext(
          app,
          orgA,
          (tx) =>
            tx.$executeRaw`UPDATE "transcript_chunks" SET "error" = ${'x'.repeat(501)}
            WHERE "transcript_id" = ${transcriptId}::uuid AND "chunk_index" = 2`,
        ),
      ).rejects.toThrow(/too long|22001/);
    });

    it('a done chunk is never downgraded (upsertChunk and markChunk, also concurrently)', async () => {
      const transcriptId = transcriptOf.get(orgA)!;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? transcripts.upsertChunk(orgA, {
                transcriptId,
                chunkIndex: 0,
                startMs: 0,
                endMs: 999,
                provider: 'other',
                status: 'pending',
                text: 'overwrite',
              })
            : transcripts.markChunk(orgA, {
                transcriptId,
                chunkIndex: 0,
                status: 'failed',
                error: 'X',
              }),
        ),
      );
      for (const r of results) {
        if (r === null) continue;
        expect('applied' in r && r.applied).toBe(false);
      }
      const [c0] = await transcripts.listChunks(orgA, transcriptId);
      expect(c0).toMatchObject({
        status: 'done',
        text: 'hello',
        provider: 'deepgram',
        endMs: 1000,
        attemptCount: 2,
      });
    });

    it('tryBeginMerge has exactly one winner under concurrency; completeMerge finishes it', async () => {
      const transcriptId = transcriptOf.get(orgA)!;
      const wins = await Promise.all(
        Array.from({ length: 10 }, () => transcripts.tryBeginMerge(orgA, transcriptId)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await transcripts.completeMerge(orgA, transcriptId, { fullText: 'hello' })).toBe(true);
      expect(await transcripts.completeMerge(orgA, transcriptId)).toBe(false);
      expect(await transcripts.tryBeginMerge(orgA, transcriptId)).toBe(false);
      const t = await runWithOrganizationContext(owner, orgA, (tx) =>
        tx.transcript.findUniqueOrThrow({ where: { id: transcriptId } }),
      );
      expect(t.mergeStatus).toBe('merged');
      expect(t.mergedAt).toBeInstanceOf(Date);
      expect(t.fullText).toBe('hello');
    });

    it('organization A cannot see or touch organization B chunks or merges', async () => {
      const tB = transcriptOf.get(orgB)!;
      await transcripts.upsertChunk(orgB, {
        transcriptId: tB,
        chunkIndex: 0,
        startMs: 0,
        endMs: 1,
        provider: 'p',
      });
      expect(await transcripts.listChunks(orgA, tB)).toEqual([]);
      expect(
        await transcripts.markChunk(orgA, { transcriptId: tB, chunkIndex: 0, status: 'done' }),
      ).toBeNull();
      expect(await transcripts.tryBeginMerge(orgA, tB)).toBe(false);
      // Writing a chunk for B's transcript from A fails (RLS WITH CHECK / composite FK), never lands in B.
      await expect(
        transcripts.upsertChunk(orgA, {
          transcriptId: tB,
          chunkIndex: 5,
          startMs: 0,
          endMs: 1,
          provider: 'p',
        }),
      ).rejects.toThrow();
      expect((await transcripts.listChunks(orgB, tB)).map((c) => c.chunkIndex)).toEqual([0]);
    });
  });

  describe('AiUsageCounter', () => {
    it('increment is atomic across concurrent callers (all five counters)', async () => {
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, () =>
          usage.increment(orgA, {
            provider: 'openai',
            periodKind: 'day',
            periodStart: '2026-10-24',
            requests: 1,
            inputTokens: 100,
            outputTokens: 10n,
            audioSeconds: '1.5',
            costUsd: '0.000123',
          }),
        ),
      );
      const totals = await usage.increment(orgA, {
        provider: 'openai',
        periodKind: 'day',
        periodStart: '2026-10-24',
      });
      expect(totals).toEqual({
        requests: N,
        inputTokens: BigInt(100 * N),
        outputTokens: BigInt(10 * N),
        audioSeconds: (1.5 * N).toFixed(3),
        costUsd: (0.000123 * N).toFixed(6),
      });
    });

    it('organizationCostSince sums cost across providers since a date (month-to-date)', async () => {
      await usage.increment(orgA, {
        provider: 'deepgram',
        periodKind: 'day',
        periodStart: '2026-10-01',
        costUsd: '1.25',
      });
      await usage.increment(orgA, {
        provider: 'deepgram',
        periodKind: 'day',
        periodStart: '2026-09-30',
        costUsd: '9',
      });
      // month bucket is excluded from the default (day) sum, so nothing is double counted
      await usage.increment(orgA, {
        provider: 'deepgram',
        periodKind: 'month',
        periodStart: '2026-10-01',
        costUsd: '1.25',
      });
      expect(await usage.organizationCostSince(orgA, '2026-10-01')).toBe('1.252460');
      expect(await usage.organizationCostSince(orgA, '2026-10-01', 'month')).toBe('1.250000');
      expect(await usage.organizationCostSince(orgB, '2026-01-01')).toBe('0');
    });

    it('month buckets must start on the first of the month (CHECK)', async () => {
      await expect(
        usage.increment(orgA, {
          provider: 'x',
          periodKind: 'month',
          periodStart: '2026-10-02',
          costUsd: 1,
        }),
      ).rejects.toThrow(/period_start_check|23514/);
    });
  });

  describe('AiIdempotency', () => {
    it('claim has exactly one winner under concurrency', async () => {
      const key = `job-${randomUUID()}`;
      const wins = await Promise.all(
        Array.from({ length: 10 }, () => idem.claim(orgA, key, 60_000)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      // other organizations have their own key space
      expect(await idem.claim(orgB, key, 60_000)).toBe(true);
    });

    it('an expired pending claim is re-claimed by exactly one caller; completed keys are not', async () => {
      const key = `job-${randomUUID()}`;
      expect(await idem.claim(orgA, key, 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      const wins = await Promise.all(
        Array.from({ length: 10 }, () => idem.claim(orgA, key, 60_000)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await idem.complete(orgA, key, 'succeeded', 'report:1')).toBe(true);
      const done = `job-${randomUUID()}`;
      expect(await idem.claim(orgA, done, 1)).toBe(true);
      expect(await idem.complete(orgA, done, 'failed')).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(await idem.claim(orgA, done, 60_000)).toBe(false);
    });
  });

  describe('RLS isolation of the new tables', () => {
    it('organization config is a JSON object, one row per organization, invisible across organizations', async () => {
      await usage.increment(orgB, {
        provider: 'openai',
        periodKind: 'day',
        periodStart: '2026-10-24',
        costUsd: '2',
      });
      await runWithOrganizationContext(app, orgB, (tx) =>
        tx.aiOrganizationConfig.create({
          data: { organizationId: orgB, config: { model: 'x' }, monthlyBudgetUsd: '50.00' },
        }),
      );
      await expect(
        runWithOrganizationContext(
          app,
          orgA,
          (tx) =>
            tx.$executeRaw`INSERT INTO "ai_org_config" ("org_id", "config") VALUES (${orgA}::uuid, '[]'::jsonb)`,
        ),
      ).rejects.toThrow(/config_object_check|23514/);
      expect(
        await runWithOrganizationContext(app, orgA, (tx) => tx.aiOrganizationConfig.count()),
      ).toBe(0);
      expect(
        await runWithOrganizationContext(app, orgB, (tx) => tx.aiOrganizationConfig.count()),
      ).toBe(1);
    });

    it.each(['ai_usage_counters', 'ai_org_config', 'ai_idempotency', 'transcript_chunks'])(
      '%s: A reads none of B, cannot insert for B, cannot update/delete B',
      async (table) => {
        const countB = (org: string) =>
          runWithOrganizationContext(app, org, (tx) =>
            tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "${table}" WHERE org_id = $1::uuid`,
              orgB,
            ),
          );
        const before = (await countB(orgB))[0]!.n;
        expect(before).toBeGreaterThan(0n);
        expect((await countB(orgA))[0]!.n).toBe(0n);
        await expect(
          runWithOrganizationContext(app, orgA, (tx) =>
            tx.$executeRawUnsafe(`INSERT INTO "${table}" (org_id) VALUES ($1::uuid)`, orgB),
          ),
        ).rejects.toThrow(/row-level security/);
        const changed = await runWithOrganizationContext(app, orgA, async (tx) => {
          const u = await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET org_id = org_id WHERE org_id = $1::uuid`,
            orgB,
          );
          const d = await tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE org_id = $1::uuid`,
            orgB,
          );
          return u + d;
        });
        expect(changed).toBe(0);
        expect((await countB(orgB))[0]!.n).toBe(before);
      },
    );
  });
});
