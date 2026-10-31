import { describe, it, expect, vi } from 'vitest';
import { EMBEDDING_DIMS, type EmbedBatchResult } from '@meetops/ai-core';
import {
  EmbeddingRetryableError,
  enqueueMeetingEmbeddings,
  loadEmbeddingsWorkerEnv,
  registerEmbeddingsWorker,
  runMeetingEmbeddings,
  type EmbedFn,
  type EmbeddingRepository,
  type EmbeddingRow,
  type EmbeddingSource,
} from '../src/embeddings/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MEETING = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const log = { info: vi.fn(), warn: vi.fn() };

/** In-memory repo keyed by org: a job for one org can never read or write another org's rows. */
function fakeRepo(sources: Record<string, EmbeddingSource[]>) {
  const stored = new Map<string, { org: string; model: string; row: EmbeddingRow }>();
  const repo: EmbeddingRepository = {
    listSources: async (org, _m, limit) => (sources[org] ?? []).slice(0, limit),
    storedHashes: async (org) => {
      const m = new Map<string, Set<string>>();
      for (const s of stored.values())
        if (s.org === org)
          (m.get(s.row.id) ?? m.set(s.row.id, new Set()).get(s.row.id)!).add(s.row.sha256);
      return m;
    },
    upsert: async (org, _m, model, rows) => {
      for (const row of rows) stored.set(`${org}:${row.id}:${model}`, { org, model, row });
      return rows.length;
    },
  };
  return { repo, stored };
}

function fakeEmbed(result?: (inputs: string[]) => EmbedBatchResult) {
  const calls: Parameters<EmbedFn>[0][] = [];
  const embed: EmbedFn = async (req) => {
    calls.push(req);
    return (
      result?.(req.inputs) ?? {
        status: 'succeeded',
        vectors: req.inputs.map(() => new Array<number>(EMBEDDING_DIMS).fill(0.1)),
        model: 'fake/embed-1',
        usage: { estimatedCostUsd: 0 },
        cached: false,
      }
    );
  };
  return { embed, calls };
}

const segs = (org: string, n: number, text = 'hello'): EmbeddingSource[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'transcript_segment' as const,
    id: id(i + 1),
    text: `${text} ${org} ${i}`,
  }));

describe('runMeetingEmbeddings', () => {
  it('batches, caps and skips unchanged content by hash on the next run', async () => {
    const { repo, stored } = fakeRepo({
      [ORG]: [...segs(ORG, 70), { kind: 'summary', id: id(999), text: 'Summary\nDecisions' }],
    });
    const { embed, calls } = fakeEmbed();
    const r = await runMeetingEmbeddings(
      { repo, embed, log, limits: { batchSize: 32, maxSources: 50 } },
      { organizationId: ORG, meetingId: MEETING },
    );
    expect(r).toMatchObject({ status: 'done', considered: 50, embedded: 50, calls: 2 });
    expect(calls.map((c) => c.inputs.length)).toEqual([32, 18]);
    expect(
      calls.every((c) => c.organizationId === ORG && c.idempotencyKey.startsWith(MEETING)),
    ).toBe(true);
    expect(stored.size).toBe(50);

    const again = fakeEmbed();
    const r2 = await runMeetingEmbeddings(
      { repo, embed: again.embed, log, limits: { batchSize: 32, maxSources: 50 } },
      { organizationId: ORG, meetingId: MEETING },
    );
    expect(r2).toMatchObject({ skipped: 50, embedded: 0, calls: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it('re-embeds only changed sources; the idempotency key is stable for the same content', async () => {
    const sources = { [ORG]: segs(ORG, 3) };
    const { repo } = fakeRepo(sources);
    const first = fakeEmbed();
    await runMeetingEmbeddings(
      { repo, embed: first.embed, log },
      { organizationId: ORG, meetingId: MEETING },
    );
    sources[ORG][1] = { ...sources[ORG][1]!, text: 'edited' };
    const second = fakeEmbed();
    const r = await runMeetingEmbeddings(
      { repo, embed: second.embed, log },
      { organizationId: ORG, meetingId: MEETING },
    );
    expect(r).toMatchObject({ skipped: 2, embedded: 1 });
    expect(second.calls[0]!.inputs).toEqual(['edited']);
    const k1 = fakeEmbed();
    const k2 = fakeEmbed();
    const { repo: fresh1 } = fakeRepo({ [ORG]: segs(ORG, 2) });
    const { repo: fresh2 } = fakeRepo({ [ORG]: segs(ORG, 2) });
    await runMeetingEmbeddings(
      { repo: fresh1, embed: k1.embed, log },
      { organizationId: ORG, meetingId: MEETING },
    );
    await runMeetingEmbeddings(
      { repo: fresh2, embed: k2.embed, log },
      { organizationId: ORG, meetingId: MEETING },
    );
    expect(k1.calls[0]!.idempotencyKey).toBe(k2.calls[0]!.idempotencyKey);
  });

  it('org isolation: a job only reads and writes its own organization', async () => {
    const { repo, stored } = fakeRepo({ [ORG]: segs(ORG, 2), [OTHER]: segs(OTHER, 2, 'secret') });
    const { embed, calls } = fakeEmbed();
    await runMeetingEmbeddings({ repo, embed, log }, { organizationId: ORG, meetingId: MEETING });
    expect(calls.flatMap((c) => c.inputs).join(' ')).not.toContain('secret');
    expect([...stored.values()].every((s) => s.org === ORG)).toBe(true);
  });

  it('unconfigured provider: stops after one call, nothing stored, no retry', async () => {
    const { repo, stored } = fakeRepo({ [ORG]: segs(ORG, 40) });
    const { embed, calls } = fakeEmbed(() => ({
      status: 'unavailable',
      errors: [{ provider: 'gemini', code: 'CAPABILITY_UNSUPPORTED' }],
    }));
    const r = await runMeetingEmbeddings(
      { repo, embed, log },
      { organizationId: ORG, meetingId: MEETING },
    );
    expect(r.status).toBe('unavailable');
    expect(calls).toHaveLength(1);
    expect(stored.size).toBe(0);
  });

  it('transient provider errors throw a retryable error; bad ids are rejected', async () => {
    const { repo } = fakeRepo({ [ORG]: segs(ORG, 1) });
    const { embed } = fakeEmbed(() => ({
      status: 'retryable',
      errors: [{ provider: 'p', code: 'RATE_LIMITED' }],
    }));
    await expect(
      runMeetingEmbeddings({ repo, embed, log }, { organizationId: ORG, meetingId: MEETING }),
    ).rejects.toBeInstanceOf(EmbeddingRetryableError);
    await expect(
      runMeetingEmbeddings({ repo, embed, log }, { organizationId: 'x', meetingId: MEETING }),
    ).rejects.toThrow(TypeError);
  });
});

describe('embeddings worker registration and producer', () => {
  it('is off by default and needs an executor when on', () => {
    expect(loadEmbeddingsWorkerEnv({}).enabled).toBe(false);
    expect(loadEmbeddingsWorkerEnv({ SEMANTIC_EMBEDDINGS_BATCH: '500' }).limits.batchSize).toBe(32);
    const start = vi.fn(() => ({ close: async () => undefined }));
    expect(
      registerEmbeddingsWorker({ env: loadEmbeddingsWorkerEnv({}), start, logger: log }),
    ).toEqual({
      registered: false,
      reason: 'disabled',
    });
    const on = loadEmbeddingsWorkerEnv({ SEMANTIC_EMBEDDINGS_ENABLED: 'true' });
    expect(registerEmbeddingsWorker({ env: on, start, logger: log }).registered).toBe(false);
    const { repo } = fakeRepo({});
    const reg = registerEmbeddingsWorker({
      env: on,
      start,
      repo,
      logger: log,
      resolveExecutor: () => ({ run: vi.fn() }),
    });
    expect(reg.registered).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('enqueues one job per meeting (deterministic jobId, ids only)', async () => {
    const add = vi.fn(async () => undefined);
    await enqueueMeetingEmbeddings({ add }, { organizationId: ORG, meetingId: MEETING });
    await enqueueMeetingEmbeddings({ add }, { organizationId: ORG, meetingId: MEETING });
    const [a, b] = add.mock.calls as unknown as [string, object, { jobId: string }][];
    expect(a![2].jobId).toBe(`embed-${ORG}-${MEETING}`);
    expect(b![2].jobId).toBe(a![2].jobId);
    expect(a![1]).toEqual({ organizationId: ORG, meetingId: MEETING });
    await expect(
      enqueueMeetingEmbeddings({ add }, { organizationId: ORG, meetingId: 'nope' }),
    ).rejects.toThrow(TypeError);
  });
});
