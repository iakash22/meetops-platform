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
  const store: TranscriptionDelayedStatus = {
    markDelayed: async () => {
      if (s === 'processing') s = 'transcription_delayed';
    },
    clearDelayed: async (_o, _m, to) => {
      if (s === 'transcription_delayed') s = to;
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
  ) {
    const name = `it-transcription-${randomUUID()}`;
    const q = new Queue<Payload>(name, { connection: connection() });
    const dlq = new Queue<TranscriptionDeadLetter>(`${name}-dlq`, { connection: connection() });
    queues.push(q, dlq);
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
          status,
          logger: silent,
        }),
      ),
    );
    worker.on('completed', (job) =>
      handled.push(handleTranscriptionSuccess(job, { status, logger: silent })),
    );
    const data: Payload = {
      organizationId: randomUUID(),
      meetingId: randomUUID(),
      recordingId: randomUUID(),
      chunkIndex: 1,
    };
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
    return { q, dlq, job, data };
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
    const { dlq, job } = await run(
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
});
