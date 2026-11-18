/**
 * Live takeover DLQ re-drive: real Redis via BullMQ, keys under a per-run `qa:it:tfr:<uuid>` prefix passed as
 * AUTH_MAIL_QUEUE_PREFIX (so the script's prefix handling is exercised) and obliterated afterwards. Skips unless
 * REDIS_IT_URL (or TEST_REDIS_URL) is set and reachable.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { TakeoverFollowUpJob } from '../src/modules/auth/domain/takeover-follow-up.js';
import {
  startTakeoverFollowUpWorker,
  TAKEOVER_FOLLOW_UP_DLQ,
  TAKEOVER_FOLLOW_UP_QUEUE,
  takeoverFollowUpJobId,
  type TakeoverDeadLetter,
} from '../src/modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';
import { main } from '../src/scripts/takeover-dlq-redrive.js';

const redisUrl = process.env.REDIS_IT_URL ?? process.env.TEST_REDIS_URL;
const PREFIX = `qa:it:tfr:${randomUUID().slice(0, 8)}`;

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

describe.skipIf(!live)('takeover follow-up DLQ re-drive (live Redis)', () => {
  let queue: Queue<TakeoverFollowUpJob>;
  let dlq: Queue<TakeoverDeadLetter>;
  const env = { REDIS_URL: redisUrl, AUTH_MAIL_QUEUE_PREFIX: PREFIX };
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const report = await main(env, argv, {
      out: (l) => void lines.push(l),
      ask: async () => 'yes',
    });
    return { report, lines };
  };
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

  it('dead-letters a failing job, dry-runs, re-drives once (idempotent) and the job then runs', async () => {
    const userId = randomUUID();
    const data: TakeoverFollowUpJob = { userId, kind: 'push_devices' };
    const jobId = takeoverFollowUpJobId(data);
    const missing: TakeoverFollowUpJob = { userId: randomUUID(), kind: 'realtime' };
    const missingId = takeoverFollowUpJobId(missing);

    // 1. A follow-up that keeps failing ends up failed + dead-lettered (real worker, short backoff).
    await queue.add(data.kind, data, {
      jobId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 50 },
      removeOnComplete: true,
    });
    const failing = startTakeoverFollowUpWorker(
      { runTakeoverFollowUp: async () => Promise.reject(new Error('push store down')) },
      { redisUrl: redisUrl!, prefix: PREFIX, concurrency: 1 },
      { error: () => {} },
      dlq,
    );
    try {
      await waitFor(async () => (await dlq.getJob(`dlq_${jobId}`)) ?? undefined);
    } finally {
      await failing.close();
    }
    expect(await (await queue.getJob(jobId))!.getState()).toBe('failed');
    // A second entry whose original is gone, plus one forged entry that must never be acted on.
    await dlq.add(
      'takeover_follow_up_dead_letter',
      { ...missing, jobId: missingId, attemptsMade: 6, errorType: 'Error', failedAt: 'x' },
      { jobId: `dlq_${missingId}` },
    );
    await dlq.add(
      'takeover_follow_up_dead_letter',
      { ...missing, jobId: 'other', attemptsMade: 6, errorType: 'Error', failedAt: 'x' },
      { jobId: 'dlq_forged' },
    );

    // 2. Dry run (default): plans, changes nothing, prints no URL.
    const dry = await run(['--all']);
    expect(dry.report.items.map((i) => i.action).sort()).toEqual([
      'invalid_payload',
      'would_enqueue',
      'would_requeue',
    ]);
    expect(dry.lines.join('\n')).not.toContain(redisUrl!);
    expect(dry.lines[0]).toContain(`prefix=${PREFIX}`);
    expect(await dlq.getJobCountByTypes('waiting')).toBe(3);
    expect(await (await queue.getJob(jobId))!.getState()).toBe('failed');
    expect(await queue.getJob(missingId)).toBeUndefined();

    // 3. Apply: failed original retried, missing one enqueued, forged one kept.
    const applied = await run(['--all', '--apply']);
    expect(applied.report.items.map((i) => i.action).sort()).toEqual([
      'enqueued',
      'invalid_payload',
      'requeued',
    ]);
    expect(await (await queue.getJob(jobId))!.getState()).toBe('waiting');
    expect((await queue.getJob(missingId))?.data).toEqual(missing);
    expect((await dlq.getJobs(['waiting'])).map((j) => j.id)).toEqual(['dlq_forged']);

    // 4. Second apply: nothing left to re-drive except the invalid entry; no duplicate jobs.
    const again = await run(['--all', '--apply']);
    expect(again.report.items.map((i) => i.action)).toEqual(['invalid_payload']);
    expect(await queue.getJobCounts('waiting', 'delayed', 'failed')).toMatchObject({
      waiting: 2,
      failed: 0,
    });

    // 5. A healthy worker now runs both follow-ups once.
    const ran: TakeoverFollowUpJob[] = [];
    const ok = startTakeoverFollowUpWorker(
      { runTakeoverFollowUp: async (j) => void ran.push(j) },
      { redisUrl: redisUrl!, prefix: PREFIX, concurrency: 1 },
      undefined,
      dlq,
    );
    try {
      await waitFor(async () => (ran.length === 2 ? true : undefined));
      expect(ran.map((j) => j.userId).sort()).toEqual([userId, missing.userId].sort());
    } finally {
      await ok.close();
    }
  }, 40_000);

  it('reads nothing under a different prefix', async () => {
    const lines: string[] = [];
    const r = await main({ REDIS_URL: redisUrl, AUTH_MAIL_QUEUE_PREFIX: `${PREFIX}x` }, ['--all'], {
      out: (l) => void lines.push(l),
      ask: async () => 'no',
    });
    expect(r.items).toEqual([]);
  });
});
