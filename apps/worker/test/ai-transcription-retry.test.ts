import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  DEFAULT_TRANSCRIPTION_RETRY,
  TRANSCRIPTION_BACKOFF_TYPE,
  TRANSCRIPTION_DLQ,
  DLQ_JOB_ID_PREFIX,
  deadLetterJobId,
  handleTranscriptionFailure,
  handleTranscriptionSuccess,
  createRedisDeadLetterIndex,
  deadLetterIndexKey,
  DEAD_LETTER_INDEX_TTL_MS,
  INDEX_ADD_SCRIPT,
  INDEX_PRUNE_SCRIPT,
  INDEX_TIME_SCRIPT,
  type DeadLetterIndex,
  meetingHasDeadLetters,
  isRetryExhausted,
  transcriptionBackoffMs,
  transcriptionBackoffStrategy,
  transcriptionJobOptions,
  type DeadLetterQueueLike,
} from '../src/ai/transcription-retry.js';
import { loadTranscriptionWorkerEnv, TranscriptionWorkerEnvError } from '../src/ai/env.js';
import { TranscriptionJobError } from '../src/ai/consumer.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const policy = { attempts: 4, baseDelayMs: 1_000, maxDelayMs: 10_000 };

describe('transcription backoff', () => {
  it('grows exponentially, with equal jitter in [exp/2, exp]', () => {
    expect(transcriptionBackoffMs(1, policy, () => 0)).toBe(500);
    expect(transcriptionBackoffMs(1, policy, () => 1)).toBe(1_000);
    expect(transcriptionBackoffMs(2, policy, () => 1)).toBe(2_000);
    expect(transcriptionBackoffMs(3, policy, () => 0.5)).toBe(3_000);
  });
  it('is capped at maxDelayMs', () => {
    expect(transcriptionBackoffMs(20, policy, () => 1)).toBe(10_000);
    expect(transcriptionBackoffMs(1_000, policy, () => 0)).toBe(5_000);
  });
  it('clamps bad random values and attempt counts', () => {
    expect(transcriptionBackoffMs(0, policy, () => 5)).toBe(1_000);
    expect(transcriptionBackoffMs(1, policy, () => -1)).toBe(500);
  });
  it('strategy applies the policy', () => {
    const s = transcriptionBackoffStrategy(policy, () => 1);
    expect(s(2)).toBe(2_000);
    expect(s(9)).toBe(10_000);
  });
  it('job options use the policy attempts and the custom backoff', () => {
    expect(transcriptionJobOptions(policy)).toMatchObject({
      attempts: 4,
      backoff: { type: TRANSCRIPTION_BACKOFF_TYPE },
    });
    expect(transcriptionJobOptions().attempts).toBe(DEFAULT_TRANSCRIPTION_RETRY.attempts);
  });
});

describe('transcription retry env', () => {
  it('defaults', () => {
    expect(loadTranscriptionWorkerEnv({}).retry).toEqual(DEFAULT_TRANSCRIPTION_RETRY);
  });
  it('reads overrides', () => {
    expect(
      loadTranscriptionWorkerEnv({
        TRANSCRIPTION_MAX_ATTEMPTS: '3',
        TRANSCRIPTION_BACKOFF_BASE_MS: '2000',
        TRANSCRIPTION_BACKOFF_MAX_MS: '60000',
      }).retry,
    ).toEqual({ attempts: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 });
  });
  it('rejects out-of-range and inconsistent values', () => {
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_MAX_ATTEMPTS: '0' })).toThrow(
      TranscriptionWorkerEnvError,
    );
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_MAX_ATTEMPTS: 'x' })).toThrow(
      TranscriptionWorkerEnvError,
    );
    expect(() =>
      loadTranscriptionWorkerEnv({
        TRANSCRIPTION_BACKOFF_BASE_MS: '50000',
        TRANSCRIPTION_BACKOFF_MAX_MS: '10000',
      }),
    ).toThrow(TranscriptionWorkerEnvError);
  });
});

describe('dead-lettering', () => {
  const job = (attemptsMade: number, attempts = 4) => ({
    id: 'job-1',
    data: { organizationId: ORG, meetingId: MEET, recordingId: REC, chunkIndex: 2 },
    attemptsMade,
    opts: { attempts },
  });
  const setup = () => {
    const dlq = { add: vi.fn<DeadLetterQueueLike['add']>(async () => undefined) };
    const status = {
      markDelayed: vi.fn(async () => undefined),
      readDelayed: vi.fn(async (): Promise<{ version: string } | null> => ({ version: 'v1' })),
      clearDelayed: vi.fn(async () => true),
    };
    const alert = vi.fn();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const deps = { dlq, status, alert, logger, now: () => new Date('2026-11-03T12:00:00Z') };
    return { dlq, status, alert, logger, deps };
  };
  const outage = new TranscriptionJobError('provider_retryable', true);

  it('does nothing while retries remain', async () => {
    const { deps, dlq, status, alert } = setup();
    expect(await handleTranscriptionFailure(job(2), outage, deps)).toBe(false);
    expect(dlq.add).not.toHaveBeenCalled();
    expect(status.markDelayed).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('never dead-letters permanent (unrecoverable) errors', async () => {
    const { deps, dlq } = setup();
    const err = new UnrecoverableError('transcription job failed: invalid_payload');
    expect(isRetryExhausted(job(1), err)).toBe(false);
    expect(await handleTranscriptionFailure(job(4), err, deps)).toBe(false);
    expect(dlq.add).not.toHaveBeenCalled();
  });

  it('on the last attempt: DLQ entry (ids + code only), delayed status, alert', async () => {
    const { deps, dlq, status, alert, logger } = setup();
    expect(await handleTranscriptionFailure(job(4), outage, deps)).toBe(true);
    const entry = {
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 2,
      jobId: 'job-1',
      errorCode: 'provider_retryable',
      attemptsMade: 4,
      failedAt: '2026-11-03T12:00:00.000Z',
    };
    expect(dlq.add).toHaveBeenCalledWith('transcription_dead_letter', entry, {
      jobId: 'dlq_job-1',
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(alert).toHaveBeenCalledWith(entry);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, errorCode: 'provider_retryable' }),
      expect.stringContaining('transcription delayed'),
    );
  });

  it('one failing step does not stop the others', async () => {
    const { deps, dlq, status, alert, logger } = setup();
    dlq.add.mockRejectedValueOnce(new Error('redis down'));
    status.markDelayed.mockRejectedValueOnce(new Error('db down'));
    alert.mockRejectedValueOnce(new Error('hook down'));
    expect(await handleTranscriptionFailure(job(4), outage, deps)).toBe(true);
    expect(status.markDelayed).toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('unknown errors map to provider_unavailable; jobs without ids are ignored', async () => {
    const { deps, dlq } = setup();
    await handleTranscriptionFailure(job(4), new Error('boom'), deps);
    expect(dlq.add.mock.calls[0]![1].errorCode).toBe('provider_unavailable');
    expect(
      await handleTranscriptionFailure({ attemptsMade: 9, opts: { attempts: 1 } }, outage, deps),
    ).toBe(false);
    expect(await handleTranscriptionFailure(undefined, outage, deps)).toBe(false);
  });

  it('DLQ job ids never contain ":" (BullMQ 5.81 rejects them) and use the dlq_ prefix', () => {
    expect(deadLetterJobId('job-1', REC, 2)).toBe('dlq_job-1');
    expect(deadLetterJobId('a:b:c', REC, 2)).toBe('dlq_a_b_c');
    expect(deadLetterJobId(undefined, REC, 3)).toBe(`dlq_${REC}_3`);
    expect(deadLetterJobId(undefined, REC, undefined)).toBe(`dlq_${REC}_0`);
    for (const id of [deadLetterJobId('x:y', REC, 1), deadLetterJobId(undefined, REC, 1)]) {
      expect(id.startsWith(DLQ_JOB_ID_PREFIX)).toBe(true);
      expect(id).not.toContain(':');
    }
  });

  it('a final permanent failure moves a delayed meeting to failed (and is not dead-lettered)', async () => {
    const { deps, dlq, status } = setup();
    const err = new UnrecoverableError('transcription job failed: provider_failed');
    expect(await handleTranscriptionFailure(job(1), err, deps)).toBe(false);
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'failed');
    expect(status.markDelayed).not.toHaveBeenCalled();
    expect(dlq.add).not.toHaveBeenCalled();
  });

  it('a retry-exhausted failure parks the meeting in transcription_delayed and does not clear it', async () => {
    const { deps, status } = setup();
    await handleTranscriptionFailure(job(4), outage, deps);
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  const dead = (jobId: string, meetingId = MEET, organizationId = ORG) => ({
    id: `dlq_${jobId}`,
    data: {
      organizationId,
      meetingId,
      recordingId: REC,
      chunkIndex: 0,
      jobId,
      errorCode: 'provider_retryable',
      attemptsMade: 4,
      failedAt: '2026-11-03T12:00:00.000Z',
    },
  });

  it('a success moves a delayed meeting back to processing when none of its chunks is dead-lettered', async () => {
    const { status, logger } = setup();
    // Other meetings' / orgs' entries and the succeeding job's own entry do not count.
    const deadLetters = async () => [
      dead('other', '99999999-9999-4999-8999-999999999999'),
      dead('x', MEET, '88888888-8888-4888-8888-888888888888'),
      dead('job-1'),
    ];
    await handleTranscriptionSuccess(job(1), { status, deadLetters, logger });
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'processing', 'v1');
    expect(status.markDelayed).not.toHaveBeenCalled();
  });

  it('a success does NOT clear transcription_delayed while another chunk of the meeting is dead-lettered', async () => {
    const { status, logger } = setup();
    await handleTranscriptionSuccess(job(1), {
      status,
      deadLetters: async () => [dead('job-2')],
      logger,
    });
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('a success leaves the meeting delayed when the DLQ cannot be read or no lister is wired', async () => {
    const { status, logger } = setup();
    await handleTranscriptionSuccess(job(1), {
      status,
      deadLetters: async () => {
        throw new Error('redis down');
      },
      logger,
    });
    await handleTranscriptionSuccess(job(1), { status, logger });
    expect(status.clearDelayed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, meetingId: MEET }),
      'transcription dead-letter lookup failed; meeting left delayed',
    );
  });

  it('a clear-status write error is logged only', async () => {
    const { status, logger } = setup();
    status.clearDelayed.mockRejectedValueOnce(new Error('db down'));
    await expect(
      handleTranscriptionSuccess(job(1), { status, deadLetters: async () => [], logger }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, meetingId: MEET }),
      'transcription delayed-status clear failed',
    );
    await handleTranscriptionSuccess(undefined, { status, deadLetters: async () => [], logger });
    expect(status.clearDelayed).toHaveBeenCalledTimes(1);
  });

  it('meetingHasDeadLetters matches org + meeting and honours exclusions', () => {
    const entries = [dead('a'), dead('b', '99999999-9999-4999-8999-999999999999')];
    expect(meetingHasDeadLetters(entries, ORG, MEET)).toBe(true);
    expect(meetingHasDeadLetters(entries, ORG, MEET, ['a'])).toBe(false);
    expect(meetingHasDeadLetters(entries, '88888888-8888-4888-8888-888888888888', MEET)).toBe(
      false,
    );
  });

  /** In-memory Redis ZSET + the index's Lua scripts, with a server clock in µs and call counters. */
  function fakeRedis() {
    const z = new Map<string, Map<string, number>>();
    const clock = { us: 1_000_000_000 };
    const ttl = new Map<string, number>();
    const zset = (k: string) => z.get(k) ?? z.set(k, new Map()).get(k)!;
    const bound = (v: number | string) => {
      const x = String(v);
      if (x === '-inf') return { v: -Infinity, ex: false };
      if (x === '+inf') return { v: Infinity, ex: false };
      return x.startsWith('(') ? { v: Number(x.slice(1)), ex: true } : { v: Number(x), ex: false };
    };
    const inRange = (sc: number, min: number | string, max: number | string) => {
      const a = bound(min);
      const b = bound(max);
      return (a.ex ? sc > a.v : sc >= a.v) && (b.ex ? sc < b.v : sc <= b.v);
    };
    const redis = {
      zrange: vi.fn(async (k: string) =>
        [...(z.get(k) ?? new Map<string, number>())].flatMap(([m, sc]) => [m, String(sc)]),
      ),
      zrangebyscore: vi.fn(async (k: string, min: number | string, max: number | string) =>
        [...(z.get(k) ?? new Map<string, number>())]
          .filter(([, sc]) => inRange(sc, min, max))
          .map(([m]) => m),
      ),
      zremrangebyscore: vi.fn(async (k: string, min: number | string, max: number | string) => {
        let n = 0;
        for (const [m, sc] of z.get(k) ?? []) if (inRange(sc, min, max) && z.get(k)!.delete(m)) n++;
        return n;
      }),
      eval: vi.fn(async (script: string, _n: number, ...args: (string | number)[]) => {
        if (script === INDEX_TIME_SCRIPT) return clock.us;
        if (script === INDEX_ADD_SCRIPT) {
          const [k, m, ttlMs] = args as [string, string, number];
          zset(k).set(m, clock.us);
          ttl.set(k, Number(ttlMs));
          return clock.us;
        }
        if (script === INDEX_PRUNE_SCRIPT) {
          const [k, m, cutoff] = args as [string, string, number];
          const sc = z.get(k)?.get(m);
          if (sc !== undefined && sc <= Number(cutoff)) return z.get(k)!.delete(m) ? 1 : 0;
          return 0;
        }
        throw new Error('unknown script');
      }),
    };
    /** Direct seed with an explicit score (simulates an old entry). */
    const seed = (k: string, m: string, score: number) => void zset(k).set(m, score);
    return { redis, z, clock, ttl, seed };
  }

  const mockIndex = (over: Partial<Record<keyof DeadLetterIndex, unknown>> = {}) => ({
    time: vi.fn(async () => 5_000),
    add: vi.fn(async () => undefined),
    hasLive: vi.fn(async () => false),
    hasSince: vi.fn(async () => false),
    clearBefore: vi.fn(async () => undefined),
    ...over,
  });

  it('success path: a meeting that is not delayed returns before any DLQ or index read (call count)', async () => {
    const { status, logger } = setup();
    status.readDelayed.mockResolvedValue(null);
    const deadLetters = vi.fn(async () => [dead('job-2')]);
    const index = mockIndex({ hasLive: vi.fn(async () => true) });
    for (let i = 0; i < 100; i++)
      await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(status.readDelayed).toHaveBeenCalledTimes(100);
    expect(deadLetters).not.toHaveBeenCalled();
    expect(index.time).not.toHaveBeenCalled();
    expect(index.hasLive).not.toHaveBeenCalled();
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('success path: a status read error leaves the meeting delayed', async () => {
    const { status, logger } = setup();
    status.readDelayed.mockRejectedValueOnce(new Error('db down'));
    await handleTranscriptionSuccess(job(1), { status, deadLetters: async () => [], logger });
    expect(status.clearDelayed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEET }),
      'transcription dead-letter lookup failed; meeting left delayed',
    );
  });

  it('success path: a live index entry blocks without any DLQ scan; read errors keep it delayed', async () => {
    const { status, logger } = setup();
    const deadLetters = vi.fn(async () => []);
    const index = mockIndex({ hasLive: vi.fn(async () => true) });
    for (let i = 0; i < 50; i++)
      await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(index.hasLive).toHaveBeenCalledWith(ORG, MEET, ['dlq_job-1']);
    expect(deadLetters).not.toHaveBeenCalled();
    expect(status.clearDelayed).not.toHaveBeenCalled();
    index.hasLive.mockRejectedValueOnce(new Error('redis down'));
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    index.time.mockRejectedValueOnce(new Error('redis down'));
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('success path: an empty index is not trusted; a full scan confirms, then a CAS clear and clearBefore(t0)', async () => {
    const { status, logger } = setup();
    const index = mockIndex();
    // Index lost the sibling (failed write / expired key) but the DLQ still has it: stays delayed.
    const withSibling = vi.fn(async () => [dead('job-2')]);
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters: withSibling, logger });
    expect(withSibling).toHaveBeenCalledTimes(1);
    expect(status.clearDelayed).not.toHaveBeenCalled();
    // Nothing left: CAS clear with the observed version, re-check, then only entries older than t0 go.
    await handleTranscriptionSuccess(job(1), {
      status,
      index,
      deadLetters: async () => [],
      logger,
    });
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'processing', 'v1');
    expect(index.hasSince).toHaveBeenCalledWith(ORG, MEET, 5_000, ['dlq_job-1']);
    expect(index.clearBefore).toHaveBeenCalledWith(ORG, MEET, 5_000);
    expect(status.markDelayed).not.toHaveBeenCalled();
    // No DLQ lister wired: cannot confirm, stays delayed.
    status.clearDelayed.mockClear();
    await handleTranscriptionSuccess(job(1), { status, index, logger });
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('Low: a blocking DLQ entry missing from the index is re-indexed by the scan', async () => {
    const { status, logger } = setup();
    const { redis, z } = fakeRedis();
    const index = createRedisDeadLetterIndex(redis, { getJobState: async () => 'waiting' });
    const deadLetters = vi.fn(async () => [dead('job-2')]);
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(z.get(deadLetterIndexKey(ORG, MEET))!.has('dlq_job-2')).toBe(true);
    // The next success is blocked by the index alone: no scan.
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(deadLetters).toHaveBeenCalledTimes(1);
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('Medium (deterministic race): a failure landing between the scan and the clear re-delays the meeting', async () => {
    // Shared state: Postgres status (with version), DLQ entries and the real index over fake Redis.
    const { redis, z, clock } = fakeRedis();
    const dlqEntries: ReturnType<typeof dead>[] = [];
    const states = new Map<string, string>();
    const index = createRedisDeadLetterIndex(redis, {
      getJobState: async (id) => states.get(id) ?? 'unknown',
    });
    const db = { status: 'transcription_delayed', version: 1 };
    const status = {
      readDelayed: vi.fn(async () =>
        db.status === 'transcription_delayed' ? { version: String(db.version) } : null,
      ),
      markDelayed: vi.fn(async () => {
        if (db.status === 'processing') {
          db.status = 'transcription_delayed';
          db.version++;
        }
      }),
      clearDelayed: vi.fn(async (_o: string, _m: string, to: string, v?: string) => {
        if (db.status !== 'transcription_delayed' || (v && v !== String(db.version))) return false;
        db.status = to;
        db.version++;
        return true;
      }),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const dlq = {
      add: vi.fn<DeadLetterQueueLike['add']>(async (_n, data, o) => {
        dlqEntries.push({ id: o.jobId, data } as ReturnType<typeof dead>);
        states.set(o.jobId, 'waiting');
      }),
    };
    const sibling = { ...job(4), id: 'job-2', data: { ...job(4).data, chunkIndex: 3 } };
    // Exact interleaving from the review: snapshot (empty) -> concurrent failure does ZADD, DLQ add and a
    // markDelayed that is a no-op (meeting still delayed) -> our clearDelayed -> our index clear.
    let first = true;
    const deadLetters = vi.fn(async () => {
      const snap = [...dlqEntries];
      if (first) {
        first = false;
        clock.us += 1;
        await handleTranscriptionFailure(sibling, outage, {
          dlq,
          status,
          index,
          alert: vi.fn(),
          logger,
          now: () => new Date(),
        });
      }
      return snap;
    });
    // markDelayed in the failure was a no-op here (still delayed) -> this mock does not bump the version,
    // which is the worst case for the CAS: the post-clear re-check must catch it.
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'processing', '1');
    expect(db.status).toBe('transcription_delayed');
    expect(dlqEntries).toHaveLength(1);
    expect(z.get(deadLetterIndexKey(ORG, MEET))!.has('dlq_job-2')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEET }),
      'transcription dead-letter raced the clear; meeting delayed again',
    );
    // A later success is blocked by the index without a scan.
    const calls = deadLetters.mock.calls.length;
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters, logger });
    expect(deadLetters).toHaveBeenCalledTimes(calls);
    expect(db.status).toBe('transcription_delayed');
  });

  it('Medium: the CAS clear does nothing when the version moved; the re-check catches a lost index write via the DLQ', async () => {
    const { status, logger } = setup();
    status.clearDelayed.mockResolvedValueOnce(false);
    const index = mockIndex();
    await handleTranscriptionSuccess(job(1), {
      status,
      index,
      deadLetters: async () => [],
      logger,
    });
    expect(index.hasSince).not.toHaveBeenCalled();
    expect(index.clearBefore).not.toHaveBeenCalled();
    expect(status.markDelayed).not.toHaveBeenCalled();
    // Cleared, index has nothing new, but the second DLQ read sees a new entry -> re-delay, keep index.
    const lister = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dead('job-3')]);
    await handleTranscriptionSuccess(job(1), { status, index, deadLetters: lister, logger });
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(index.clearBefore).not.toHaveBeenCalled();
    // A failing re-check is treated as "maybe": re-delay.
    status.markDelayed.mockClear();
    index.hasSince.mockRejectedValueOnce(new Error('redis down'));
    await handleTranscriptionSuccess(job(1), {
      status,
      index,
      deadLetters: async () => [],
      logger,
    });
    expect(status.markDelayed).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEET }),
      'transcription post-clear re-check failed; meeting delayed again',
    );
  });

  it('Medium 1: a failed index write still dead-letters, and the next success cannot clear the meeting', async () => {
    const { deps, dlq, status, logger } = setup();
    const index = mockIndex({
      add: vi.fn(async () => {
        throw new Error('redis ZADD failed');
      }),
    });
    expect(await handleTranscriptionFailure(job(4), outage, { ...deps, index })).toBe(true);
    expect(dlq.add).toHaveBeenCalledTimes(1);
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEET }),
      'transcription dead-letter index write failed',
    );
    const sibling = { ...job(1), id: 'job-2', data: { ...job(1).data, chunkIndex: 3 } };
    await handleTranscriptionSuccess(sibling, {
      status,
      index,
      deadLetters: async () => [dead('job-1')],
      logger,
    });
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('dead-lettering writes the index before the DLQ add', async () => {
    const { deps, dlq } = setup();
    const order: string[] = [];
    const index = mockIndex({ add: vi.fn(async () => void order.push('index')) });
    dlq.add.mockImplementationOnce(async () => void order.push('dlq'));
    await handleTranscriptionFailure(job(4), outage, { ...deps, index });
    expect(index.add).toHaveBeenCalledWith(ORG, MEET, 'dlq_job-1');
    expect(order).toEqual(['index', 'dlq']);
  });

  it('Low: Redis index add is one Lua script (server TIME score + ZADD + PEXPIRE); clearBefore keeps newer entries', async () => {
    const { redis, z, clock, ttl, seed } = fakeRedis();
    const index = createRedisDeadLetterIndex(
      redis,
      { getJobState: async () => 'waiting' },
      { ttlMs: 5_000 },
    );
    const key = deadLetterIndexKey(ORG, MEET);
    await index.add(ORG, MEET, 'dlq_a');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(INDEX_ADD_SCRIPT, 1, key, 'dlq_a', 5_000);
    expect(INDEX_ADD_SCRIPT).toMatch(/redis\.call\('TIME'\)[\s\S]*ZADD[\s\S]*PEXPIRE/);
    expect(z.get(key)!.get('dlq_a')).toBe(clock.us);
    expect(ttl.get(key)).toBe(5_000);
    expect(DEAD_LETTER_INDEX_TTL_MS).toBeGreaterThan(7 * 24 * 3600_000);
    const t0 = await index.time();
    expect(t0).toBe(clock.us);
    seed(key, 'dlq_old', t0 - 1);
    clock.us += 1;
    await index.add(ORG, MEET, 'dlq_new');
    expect(await index.hasSince(ORG, MEET, t0, [])).toBe(true);
    expect(await index.hasSince(ORG, MEET, t0, ['dlq_a', 'dlq_new'])).toBe(false);
    await index.clearBefore(ORG, MEET, t0);
    expect([...z.get(key)!.keys()].sort()).toEqual(['dlq_a', 'dlq_new']);
  });

  it('Medium 2 (deterministic race): a reader between the index add and the DLQ add neither clears nor prunes it', async () => {
    const { redis, z, clock } = fakeRedis();
    const states = new Map<string, string>();
    const queue = { getJobState: vi.fn(async (id: string) => states.get(id) ?? 'unknown') };
    const index = createRedisDeadLetterIndex(redis, queue, { graceMs: 60_000 });
    const key = deadLetterIndexKey(ORG, MEET);
    await index.add(ORG, MEET, 'dlq_b');
    clock.us += 10_000_000; // a success reads 10 s later
    expect(await index.hasLive(ORG, MEET, ['dlq_a'])).toBe(true);
    expect(queue.getJobState).not.toHaveBeenCalled();
    expect(z.get(key)!.has('dlq_b')).toBe(true);
    states.set('dlq_b', 'waiting');
    clock.us += 120_000_000;
    expect(await index.hasLive(ORG, MEET, ['dlq_a'])).toBe(true);
    expect(z.get(key)!.has('dlq_b')).toBe(true);
    states.set('dlq_b', 'completed');
    expect(await index.hasLive(ORG, MEET, ['dlq_a'])).toBe(false);
    expect(z.get(key)!.has('dlq_b')).toBe(false);
  });

  it('Redis index: prune is conditional on the old score (a concurrent re-add survives)', async () => {
    const { redis, z, clock } = fakeRedis();
    const index: DeadLetterIndex = createRedisDeadLetterIndex(
      redis,
      {
        getJobState: async () => {
          await index.add(ORG, MEET, 'dlq_b'); // re-added with a fresh server-time score
          return 'unknown';
        },
      },
      { graceMs: 60_000 },
    );
    await index.add(ORG, MEET, 'dlq_b');
    clock.us += 200_000_000;
    await index.hasLive(ORG, MEET, []);
    expect(z.get(deadLetterIndexKey(ORG, MEET))!.has('dlq_b')).toBe(true);
  });

  it('Redis index reads only this meeting, not the whole DLQ (5,000 other entries)', async () => {
    const { redis, seed } = fakeRedis();
    const states = new Map<string, string>();
    const queue = { getJobState: vi.fn(async (id: string) => states.get(id) ?? 'unknown') };
    const index = createRedisDeadLetterIndex(redis, queue, { graceMs: 60_000 });
    for (let i = 0; i < 5000; i++) {
      states.set(`dlq_other_${i}`, 'waiting');
      seed(deadLetterIndexKey(ORG, `m-${i}`), `dlq_other_${i}`, 0);
    }
    seed(deadLetterIndexKey(ORG, MEET), 'dlq_self', 0);
    seed(deadLetterIndexKey(ORG, MEET), 'dlq_sibling', 0);
    states.set('dlq_sibling', 'waiting');
    expect(await index.hasLive(ORG, MEET, ['dlq_self'])).toBe(true);
    expect(queue.getJobState).toHaveBeenCalledTimes(1);
    expect(redis.zrange).toHaveBeenCalledTimes(1);
    expect(redis.zrange).toHaveBeenLastCalledWith(
      deadLetterIndexKey(ORG, MEET),
      0,
      -1,
      'WITHSCORES',
    );
  });

  it('uses a dedicated DLQ name', () => {
    expect(TRANSCRIPTION_DLQ).toBe('transcription-dlq');
  });
});
