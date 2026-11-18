/**
 * Live takeover follow-up queue (#463 review): real Redis via BullMQ, keys under a per-run `qa:it:tfu:<uuid>` prefix
 * that is obliterated afterwards. Skips unless REDIS_IT_URL (or TEST_REDIS_URL) is set and reachable.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { TakeoverFollowUpJob } from '../src/modules/auth/domain/takeover-follow-up.js';
import {
  BullMqTakeoverFollowUpQueue,
  createTakeoverFollowUpProducer,
  startTakeoverFollowUpWorker,
  TAKEOVER_FOLLOW_UP_DLQ,
  TAKEOVER_FOLLOW_UP_QUEUE,
  takeoverFollowUpJobId,
  type TakeoverDeadLetter,
} from '../src/modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';

const redisUrl = process.env.REDIS_IT_URL ?? process.env.TEST_REDIS_URL;
const PREFIX = `qa:it:tfu:${randomUUID().slice(0, 8)}`;

async function reachable(): Promise<boolean> {
  if (!redisUrl) return false;
  const r = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1500,
  });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const live = await reachable();
const conn = { connection: { url: redisUrl!, maxRetriesPerRequest: null }, prefix: PREFIX };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!live)('takeover follow-up queue (live Redis)', () => {
  let queue: Queue<TakeoverFollowUpJob>;
  let dlq: Queue<TakeoverDeadLetter>;
  beforeAll(() => {
    queue = new Queue(TAKEOVER_FOLLOW_UP_QUEUE, conn);
    dlq = new Queue(TAKEOVER_FOLLOW_UP_DLQ, conn);
  });
  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await dlq?.obliterate({ force: true });
    await queue?.close();
    await dlq?.close();
  });

  it('a job enqueued while no worker runs survives a worker restart and runs once (deduped by job id)', async () => {
    const userId = randomUUID();
    const producer = createTakeoverFollowUpProducer({ redisUrl: redisUrl!, prefix: PREFIX });
    const q = new BullMqTakeoverFollowUpQueue(producer);
    await q.enqueue({ userId, kind: 'push_devices' });
    await q.enqueue({ userId, kind: 'push_devices' }); // duplicate: same deterministic id
    await producer.close!();

    const jobId = takeoverFollowUpJobId({ userId, kind: 'push_devices' });
    const stored = await queue.getJob(jobId);
    expect(stored?.data).toEqual({ userId, kind: 'push_devices' }); // ids only, in Redis
    expect(await stored!.getState()).toBe('delayed');
    expect(await queue.getJobCounts('delayed', 'waiting')).toMatchObject({ delayed: 1 });

    // Worker A starts and is stopped before the 5 s delay (a deploy / crash); nothing ran.
    const ranA: TakeoverFollowUpJob[] = [];
    const a = startTakeoverFollowUpWorker(
      { runTakeoverFollowUp: async (j) => void ranA.push(j) },
      { redisUrl: redisUrl!, prefix: PREFIX, concurrency: 1 },
      undefined,
      dlq,
    );
    await a.worker.waitUntilReady();
    await a.close();
    expect(ranA).toEqual([]);

    // Worker B (the restarted process) picks the job up from Redis.
    const ranB: TakeoverFollowUpJob[] = [];
    const b = startTakeoverFollowUpWorker(
      { runTakeoverFollowUp: async (j) => void ranB.push(j) },
      { redisUrl: redisUrl!, prefix: PREFIX, concurrency: 1 },
      undefined,
      dlq,
    );
    try {
      await waitFor(async () => (ranB.length ? true : undefined));
      expect(ranB).toEqual([{ userId, kind: 'push_devices' }]);
      // removeOnComplete: the job is gone once done.
      await waitFor(async () => ((await queue.getJob(jobId)) ? undefined : true));
    } finally {
      await b.close();
    }
  }, 30_000);

  it('a job that keeps failing is retried, then dead-lettered under dlq_<jobId>', async () => {
    const userId = randomUUID();
    const jobId = takeoverFollowUpJobId({ userId, kind: 'extension_tokens' });
    // Short backoff so the test is quick; production uses TAKEOVER_FOLLOW_UP_JOB_OPTIONS.
    await queue.add(
      'extension_tokens',
      { userId, kind: 'extension_tokens' },
      { jobId, attempts: 3, backoff: { type: 'fixed', delay: 50 }, removeOnComplete: true },
    );
    let runs = 0;
    const errors: Record<string, unknown>[] = [];
    const w = startTakeoverFollowUpWorker(
      {
        runTakeoverFollowUp: async () => {
          runs++;
          throw new Error('token store down');
        },
      },
      { redisUrl: redisUrl!, prefix: PREFIX, concurrency: 1 },
      { error: (o) => errors.push(o) },
      dlq,
    );
    try {
      const entry = await waitFor(async () => (await dlq.getJob(`dlq_${jobId}`)) ?? undefined);
      expect(runs).toBe(3);
      expect(entry.data).toMatchObject({
        userId,
        kind: 'extension_tokens',
        jobId,
        attemptsMade: 3,
      });
      expect(JSON.stringify(entry.data)).not.toContain('token store down');
      expect(errors.some((e) => e.event === 'auth.takeover.follow_up_abandoned')).toBe(true);
    } finally {
      await w.close();
    }
  }, 30_000);
});
