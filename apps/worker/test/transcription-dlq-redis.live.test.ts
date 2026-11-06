/**
 * Live (#414): transcription retry -> DLQ -> delayed status against a REAL Redis with the real BullMQ Queue/Worker.
 * Skips unless REDIS_IT_URL points at a reachable Redis (e.g. `docker run --rm -p 6390:6379 redis:7-alpine`, then
 * REDIS_IT_URL=redis://127.0.0.1:6390). Each run uses unique queue names and obliterates them afterwards.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  deadLetterJobId,
  handleTranscriptionFailure,
  handleTranscriptionSuccess,
  createRedisDeadLetterIndex,
  queueDeadLetterLister,
  deadLetterIndexKey,
  type DeadLetterIndex,
  type TranscriptionDeadLetter,
  type TranscriptionDelayedStatus,
} from '../src/ai/transcription-retry.js';

const url = process.env.REDIS_IT_URL;
async function redisUp(): Promise<boolean> {
  if (!url) return false;
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const available = await redisUp();

type Status = 'processing' | 'transcription_delayed' | 'failed';
/** In-memory meeting status with the same guards as the Prisma writer. */
function statusStore(initial: Status = 'processing') {
  let s: Status = initial;
  let v = 1;
  const store: TranscriptionDelayedStatus = {
    markDelayed: async () => {
      if (s === 'processing' || s === 'transcription_delayed') {
        s = 'transcription_delayed';
        v++;
      }
    },
    readDelayed: async () => (s === 'transcription_delayed' ? { version: String(v) } : null),
    clearDelayed: async (_o, _m, to, expected) => {
      if (s !== 'transcription_delayed' || (expected && expected !== String(v))) return false;
      s = to;
      v++;
      return true;
    },
  };
  return { store, get: () => s };
}

const silent = { warn: () => undefined, error: () => undefined };
type Payload = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  chunkIndex: number;
};

describe.skipIf(!available)('transcription DLQ with real Redis + BullMQ (live)', () => {
  const opened: { close(): Promise<unknown> }[] = [];
  const queues: Queue[] = [];
  afterAll(async () => {
    for (const o of opened.reverse()) await o.close();
    for (const q of queues) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });
  const connection = () => new Redis(url!, { maxRetriesPerRequest: null });

  async function run(
    processor: (job: Job<Payload>) => Promise<unknown>,
    attempts: number,
    status: TranscriptionDelayedStatus,
    /** Worker events to wait for: one per attempt that ends ('failed' per failed attempt, or 'completed'). */
    expectedEvents: number,
    /** Pre-existing DLQ entries (other chunks of the same meeting). */
    seed?: (
      dlq: Queue<TranscriptionDeadLetter>,
      data: Payload,
      index: DeadLetterIndex,
      /** Raw Redis, e.g. to seed entries as if added long ago (score 0, past the grace period). */
      redis: Redis,
    ) => Promise<unknown>,
  ) {
    const name = `it-transcription-${randomUUID()}`;
    const q = new Queue<Payload>(name, { connection: connection() });
    const dlq = new Queue<TranscriptionDeadLetter>(`${name}-dlq`, { connection: connection() });
    queues.push(q, dlq);
    const indexRedis = connection();
    opened.push({ close: async () => indexRedis.disconnect() });
    const index = createRedisDeadLetterIndex(indexRedis, dlq);
    const events = new QueueEvents(name, { connection: connection() });
    opened.push(events);
    await events.waitUntilReady();
    const worker = new Worker<Payload>(name, processor, {
      connection: connection(),
      settings: { backoffStrategy: () => 10 },
    });
    opened.push(worker);
    const handled: Promise<unknown>[] = [];
    worker.on('failed', (job, err) =>
      handled.push(
        handleTranscriptionFailure(job, err, {
          dlq,
          index,
          status,
          logger: silent,
        }),
      ),
    );
    worker.on('completed', (job) =>
      handled.push(
        handleTranscriptionSuccess(job, {
          status,
          index,
          deadLetters: queueDeadLetterLister(dlq),
          logger: silent,
        }),
      ),
    );
    const data: Payload = {
      organizationId: randomUUID(),
      meetingId: randomUUID(),
      recordingId: randomUUID(),
      chunkIndex: 1,
    };
    await seed?.(dlq, data, index, indexRedis);
    const job = await q.add('transcribe', data, {
      jobId: `tx_${data.recordingId}_1`,
      attempts,
      backoff: { type: 'transcription-jitter' },
    });
    await job.waitUntilFinished(events, 15_000).catch(() => undefined);
    // Let the 'failed'/'completed' listeners finish their async writes.
    for (let i = 0; i < 250 && handled.length < expectedEvents; i++)
      await new Promise((r) => setTimeout(r, 20));
    await Promise.all(handled);
    return { q, dlq, job, data, indexRedis };
  }

  it('BullMQ rejects the old "dlq:<id>" job id; the dlq_ id is accepted', async () => {
    const q = new Queue(`it-ids-${randomUUID()}`, { connection: connection() });
    queues.push(q);
    await expect(q.add('x', {}, { jobId: 'dlq:job-1' })).rejects.toThrow(/cannot contain :/);
    await expect(
      q.add('x', {}, { jobId: deadLetterJobId('job-1', 'r', 0) }),
    ).resolves.toBeDefined();
  });

  it('retries exhausted: DLQ entry exists under the dlq_ id, meeting is transcription_delayed', async () => {
    const st = statusStore();
    const { dlq, job, indexRedis } = await run(
      async () => {
        throw new Error('provider down');
      },
      2,
      st.store,
      2,
    );
    const entry = await dlq.getJob(deadLetterJobId(job.id, 'unused', 0));
    expect(entry, 'dead-letter job in Redis').toBeDefined();
    expect(entry!.data.attemptsMade).toBe(2);
    expect(entry!.data.jobId).toBe(job.id);
    expect(st.get()).toBe('transcription_delayed');
    // The per-meeting index holds the dlq_ id.
    expect(
      await indexRedis.zrange(
        deadLetterIndexKey(entry!.data.organizationId, entry!.data.meetingId),
        0,
        -1,
      ),
    ).toEqual([deadLetterJobId(job.id, 'unused', 0)]);
  });

  it('a later success leaves transcription_delayed (back to processing)', async () => {
    const st = statusStore('transcription_delayed');
    await run(async () => ({ ok: true }), 1, st.store, 1);
    expect(st.get()).toBe('processing');
  });

  it('a final permanent failure leaves transcription_delayed (to failed) and is not dead-lettered', async () => {
    const st = statusStore('transcription_delayed');
    const { dlq, job } = await run(
      async () => {
        throw new UnrecoverableError('transcription job failed: provider_failed');
      },
      3,
      st.store,
      1,
    );
    expect(st.get()).toBe('failed');
    expect(await dlq.getJob(deadLetterJobId(job.id, 'unused', 0))).toBeUndefined();
  });

  it('a success does not clear transcription_delayed while another chunk of the meeting is in the DLQ', async () => {
    const st = statusStore('transcription_delayed');
    await run(
      async () => ({ ok: true }),
      1,
      st.store,
      1,
      async (dlq, d, index) => {
        const id = deadLetterJobId(`tx_${d.recordingId}_0`, d.recordingId, 0);
        await index.add(d.organizationId, d.meetingId, id);
        await dlq.add(
          'transcription_dead_letter',
          {
            organizationId: d.organizationId,
            meetingId: d.meetingId,
            recordingId: d.recordingId,
            chunkIndex: 0,
            jobId: `tx_${d.recordingId}_0`,
            errorCode: 'provider_retryable',
            attemptsMade: 2,
            failedAt: new Date().toISOString(),
          },
          { jobId: id },
        );
      },
    );
    expect(st.get()).toBe('transcription_delayed');
  });

  it('a stale index member (DLQ job already redriven/removed) is pruned and the meeting clears', async () => {
    const st = statusStore('transcription_delayed');
    let key = '';
    const { indexRedis } = await run(
      async () => ({ ok: true }),
      1,
      st.store,
      1,
      async (_dlq, d, _index, redis) => {
        key = deadLetterIndexKey(d.organizationId, d.meetingId);
        await redis.zadd(key, 0, 'dlq_gone');
      },
    );
    expect(st.get()).toBe('processing');
    // Pruned (and anything older than the success's read time removed): the key is gone.
    expect(await indexRedis.exists(key)).toBe(0);
  });

  it('race: a sibling indexed but whose DLQ add has not landed yet (in grace) keeps the meeting delayed', async () => {
    const st = statusStore('transcription_delayed');
    let key = '';
    const { indexRedis } = await run(
      async () => ({ ok: true }),
      1,
      st.store,
      1,
      async (_dlq, d, index) => {
        key = deadLetterIndexKey(d.organizationId, d.meetingId);
        await index.add(d.organizationId, d.meetingId, 'dlq_in_flight');
      },
    );
    expect(st.get()).toBe('transcription_delayed');
    expect(await indexRedis.zrange(key, 0, -1)).toEqual(['dlq_in_flight']);
    expect(await indexRedis.pttl(key)).toBeGreaterThan(0);
  });

  it('Low: index scores come from Redis server TIME (µs), written with the TTL in one script', async () => {
    const r = connection();
    opened.push({ close: async () => r.disconnect() });
    const index = createRedisDeadLetterIndex(r, { getJobState: async () => 'waiting' });
    const o = randomUUID();
    const m = randomUUID();
    const key = deadLetterIndexKey(o, m);
    const [sec, usec] = await r.time();
    await index.add(o, m, 'dlq_x');
    const score = Number(await r.zscore(key, 'dlq_x'));
    expect(score).toBeGreaterThanOrEqual(Number(sec) * 1e6 + Number(usec));
    expect(await r.pttl(key)).toBeGreaterThan(0);
    const t0 = await index.time();
    expect(t0).toBeGreaterThanOrEqual(score);
    await index.add(o, m, 'dlq_y');
    await index.clearBefore(o, m, t0);
    expect(await r.zrange(key, 0, -1)).toEqual(['dlq_y']);
    await r.del(key);
  });

  it('Medium probe: a real failure between the DLQ snapshot and the clear leaves the meeting delayed', async () => {
    const name = `it-race-${randomUUID()}`;
    const dlq = new Queue<TranscriptionDeadLetter>(`${name}-dlq`, { connection: connection() });
    queues.push(dlq);
    const r = connection();
    opened.push({ close: async () => r.disconnect() });
    const index = createRedisDeadLetterIndex(r, dlq);
    // Meeting already delayed; the concurrent failure's markDelayed is a real no-op on status.
    let s: Status = 'transcription_delayed';
    const status: TranscriptionDelayedStatus = {
      markDelayed: async () => {
        if (s === 'processing') s = 'transcription_delayed';
      },
      readDelayed: async () => (s === 'transcription_delayed' ? { version: 'v' } : null),
      clearDelayed: async (_o, _m, to) => {
        if (s !== 'transcription_delayed') return false;
        s = to;
        return true;
      },
    };
    const d = {
      organizationId: randomUUID(),
      meetingId: randomUUID(),
      recordingId: randomUUID(),
      chunkIndex: 1,
    };
    const realLister = queueDeadLetterLister(dlq);
    let first = true;
    const deadLetters = async () => {
      const snapshot = await realLister();
      if (first) {
        first = false;
        // Sibling chunk exhausts its retries now: real ZADD (Lua), real DLQ add, no-op markDelayed.
        await handleTranscriptionFailure(
          {
            id: 'tx_sibling',
            data: { ...d, chunkIndex: 2 },
            attemptsMade: 2,
            opts: { attempts: 2 },
          },
          new Error('provider down'),
          { dlq, index, status, logger: silent },
        );
      }
      return snapshot;
    };
    await handleTranscriptionSuccess(
      { id: 'tx_self', data: d },
      { status, index, deadLetters, logger: silent },
    );
    const siblingId = deadLetterJobId('tx_sibling', d.recordingId, 2);
    expect(s).toBe('transcription_delayed');
    expect(await dlq.getJob(siblingId)).toBeDefined();
    expect(await r.zrange(deadLetterIndexKey(d.organizationId, d.meetingId), 0, -1)).toEqual([
      siblingId,
    ]);
    await r.del(deadLetterIndexKey(d.organizationId, d.meetingId));
  });
});
