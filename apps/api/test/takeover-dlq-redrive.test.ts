import { describe, expect, it } from 'vitest';
import type { TakeoverFollowUpJob } from '../src/modules/auth/domain/takeover-follow-up.js';
import {
  TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS,
  legacyTakeoverFollowUpJobId,
  takeoverDeadLetterJobId,
  takeoverFollowUpJobId,
} from '../src/modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';
import {
  formatTakeoverRedriveItem,
  parseTakeoverRedriveArgs,
  redriveTakeoverFollowUpDlq,
  type TakeoverDlqEntryLike,
  type TakeoverRedriveQueues,
} from '../src/modules/auth/infrastructure/takeover-queue/dlq-redrive.js';
import { main, redactUrls } from '../src/scripts/takeover-dlq-redrive.js';

const job = (userId: string, kind: TakeoverFollowUpJob['kind']): TakeoverFollowUpJob => ({
  userId,
  kind,
});

/** In-memory DLQ + follow-up queue with BullMQ-like semantics (add dedupes on job id). */
function fakeQueues() {
  const dlq = new Map<string, TakeoverDlqEntryLike>();
  const jobs = new Map<string, { state: string; data: TakeoverFollowUpJob; retries: number }>();
  const calls: string[] = [];
  const dead = (j: TakeoverFollowUpJob, over: Record<string, unknown> = {}, id?: string) => {
    const jobId = takeoverFollowUpJobId(j);
    const dlqId = id ?? takeoverDeadLetterJobId(jobId);
    dlq.set(dlqId, {
      id: dlqId,
      data: { ...j, jobId, attemptsMade: 6, errorType: 'Error', failedAt: 'x', ...over },
      remove: async () => {
        calls.push(`remove ${dlqId}`);
        dlq.delete(dlqId);
      },
    });
    return jobId;
  };
  const queues: TakeoverRedriveQueues = {
    listDeadLetters: async () => [...dlq.values()],
    getFollowUpJob: async (id) => {
      const j = jobs.get(id);
      if (!j) return undefined;
      return {
        getState: async () => j.state,
        retry: async (state, opts) => {
          calls.push(`retry ${id} ${state} ${JSON.stringify(opts)}`);
          j.state = 'waiting';
          j.retries++;
        },
      };
    },
    enqueueFollowUp: async (data, id) => {
      calls.push(`enqueue ${id}`);
      if (!jobs.has(id)) jobs.set(id, { state: 'waiting', data, retries: 0 });
    },
  };
  return { dlq, jobs, calls, dead, queues };
}

const yes = async () => true;

describe('parseTakeoverRedriveArgs', () => {
  it('defaults to a dry run; --apply turns it off; --dry-run always wins', () => {
    expect(parseTakeoverRedriveArgs(['--all'])).toEqual({
      filter: { all: true },
      dryRun: true,
      yes: false,
    });
    expect(parseTakeoverRedriveArgs(['--all', '--apply', '--yes'])).toMatchObject({
      dryRun: false,
      yes: true,
    });
    expect(parseTakeoverRedriveArgs(['--apply', '--dry-run', '--all']).dryRun).toBe(true);
  });

  it('validates selectors and rejects unknown or duplicate ones', () => {
    const id = takeoverFollowUpJobId(job('u1', 'realtime'));
    expect(parseTakeoverRedriveArgs(['--job', id]).filter).toEqual({ jobId: id });
    expect(parseTakeoverRedriveArgs(['--job', `dlq_${id}`]).filter).toEqual({ jobId: `dlq_${id}` });
    expect(parseTakeoverRedriveArgs(['--user', 'u_1-2']).filter).toEqual({ userId: 'u_1-2' });
    expect(parseTakeoverRedriveArgs(['--kind', 'push_devices']).filter).toEqual({
      kind: 'push_devices',
    });
    for (const bad of [
      [],
      ['--job', 'auth-mail:1'],
      ['--job'],
      ['--user', 'a b'],
      ['--user', 'x'.repeat(65)],
      ['--kind', 'emails'],
      ['--all', '--user', 'u1'],
      ['--org', 'x'],
    ])
      expect(() => parseTakeoverRedriveArgs(bad)).toThrow();
  });
});

describe('redriveTakeoverFollowUpDlq', () => {
  it('dry run plans every case and changes nothing', async () => {
    const f = fakeQueues();
    const failed = f.dead(job('u1', 'realtime'));
    f.jobs.set(failed, { state: 'failed', data: job('u1', 'realtime'), retries: 0 });
    f.dead(job('u2', 'extension_tokens')); // original gone
    const pending = f.dead(job('u3', 'push_devices'));
    f.jobs.set(pending, { state: 'delayed', data: job('u3', 'push_devices'), retries: 0 });
    let asked = false;
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: true,
      confirm: async () => (asked = true),
    });
    expect(r.items.map((i) => i.action)).toEqual([
      'would_requeue',
      'would_enqueue',
      'would_drop_duplicate',
    ]);
    expect(asked).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.dlq.size).toBe(3);
  });

  it('apply: retries failed originals, enqueues missing ones, drops duplicates; a second run is a no-op', async () => {
    const f = fakeQueues();
    const failed = f.dead(job('u1', 'realtime'));
    f.jobs.set(failed, { state: 'failed', data: job('u1', 'realtime'), retries: 0 });
    const missing = f.dead(job('u2', 'extension_tokens'));
    const pending = f.dead(job('u3', 'push_devices'));
    f.jobs.set(pending, { state: 'active', data: job('u3', 'push_devices'), retries: 0 });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => i.action)).toEqual(['requeued', 'enqueued', 'already_requeued']);
    expect(f.calls).toEqual([
      `retry ${failed} failed {"resetAttemptsMade":true,"resetAttemptsStarted":true}`,
      `remove dlq_${failed}`,
      `enqueue ${missing}`,
      `remove dlq_${missing}`,
      `remove dlq_${pending}`,
    ]);
    expect(f.jobs.get(missing)?.data).toEqual(job('u2', 'extension_tokens'));
    expect(f.dlq.size).toBe(0);
    const again = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(again.items).toEqual([]);
    expect(f.jobs.get(failed)?.retries).toBe(1);
  });

  it('re-checks state before acting: an original re-queued since the plan is not retried twice', async () => {
    const f = fakeQueues();
    const id = f.dead(job('u1', 'realtime'));
    f.jobs.set(id, { state: 'failed', data: job('u1', 'realtime'), retries: 0 });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: async () => {
        f.jobs.get(id)!.state = 'waiting'; // another operator got there first
        return true;
      },
    });
    expect(r.items[0]!.action).toBe('already_requeued');
    expect(f.calls).toEqual([`remove dlq_${id}`]);
  });

  it('abort changes nothing', async () => {
    const f = fakeQueues();
    f.dead(job('u1', 'realtime'));
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: async () => false,
    });
    expect(r.aborted).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('keeps entries whose payload or ids do not validate, and never enqueues them', async () => {
    const f = fakeQueues();
    const real = takeoverFollowUpJobId(job('victim', 'realtime'));
    f.dead(job('u1', 'realtime'), { kind: 'emails' }); // bad kind
    f.dead(job('u2', 'realtime'), { userId: 'a b' }); // bad user id
    f.dead(job('u3', 'realtime'), { jobId: real }); // jobId of someone else
    f.dead(job('u4', 'realtime'), {}, 'dlq_forged'); // DLQ id does not match
    f.dlq.set('dlq_null', { id: 'dlq_null', data: null, remove: async () => {} });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => i.action)).toEqual(Array(5).fill('invalid_payload'));
    expect(r.items.every((i) => i.userId === undefined && i.jobId === undefined)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.dlq.size).toBe(5);
  });

  it('filters by job id, DLQ id, user and kind', async () => {
    const f = fakeQueues();
    const a = f.dead(job('u1', 'realtime'));
    f.dead(job('u1', 'push_devices'));
    f.dead(job('u2', 'push_devices'));
    const plan = async (filter: Parameters<typeof redriveTakeoverFollowUpDlq>[1]['filter']) =>
      (await redriveTakeoverFollowUpDlq(f.queues, { filter, dryRun: true, confirm: yes })).items
        .map((i) => `${i.userId}/${i.kind}`)
        .sort();
    expect(await plan({ jobId: a })).toEqual(['u1/realtime']);
    expect(await plan({ jobId: `dlq_${a}` })).toEqual(['u1/realtime']);
    expect(await plan({ userId: 'u1' })).toEqual(['u1/push_devices', 'u1/realtime']);
    expect(await plan({ kind: 'push_devices' })).toEqual(['u1/push_devices', 'u2/push_devices']);
  });

  it('prints ids, kind and a safe error class only', async () => {
    const f = fakeQueues();
    f.dead(job('u1', 'realtime'), { errorType: 'Error: redis://user:hunter2@host' });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: true,
      confirm: yes,
    });
    const line = formatTakeoverRedriveItem(r.items[0]!);
    expect(line).toMatch(
      /^would_enqueue\s+dlq=dlq_takeover_realtime_[0-9]+_[0-9a-f]{40} kind=realtime user=u1/,
    );
    expect(line).toContain('error=unknown');
    expect(line).not.toContain('hunter2');
  });

  it('still redrives an entry whose job id uses an earlier time bucket', async () => {
    const f = fakeQueues();
    const j = job('u1', 'realtime');
    const oldId = takeoverFollowUpJobId(j, 0);
    const nowId = takeoverFollowUpJobId(j, TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS);
    expect(oldId).not.toBe(nowId);
    const dlqId = takeoverDeadLetterJobId(oldId);
    f.dlq.set(dlqId, {
      id: dlqId,
      data: { ...j, jobId: oldId, attemptsMade: 6, errorType: 'TypeError', failedAt: 'x' },
      remove: async () => {
        f.calls.push(`remove ${dlqId}`);
        f.dlq.delete(dlqId);
      },
    });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => i.action)).toEqual(['enqueued']);
    expect(r.items[0]).toMatchObject({ jobId: oldId, errorType: 'TypeError' });
    expect(f.calls).toEqual([`enqueue ${oldId}`, `remove ${dlqId}`]);
  });

  it('accepts #469-format job ids without the time bucket (T&S low on #496)', async () => {
    const f = fakeQueues();
    const j = job('u1', 'push_devices');
    const legacyId = legacyTakeoverFollowUpJobId(j)!;
    expect(legacyId).toMatch(/^takeover_push_devices_[0-9a-f]{40}$/);
    const dlqId = takeoverDeadLetterJobId(legacyId);
    f.dlq.set(dlqId, {
      id: dlqId,
      data: { ...j, jobId: legacyId, attemptsMade: 6, errorType: 'TypeError', failedAt: 'x' },
      remove: async () => {
        f.calls.push(`remove ${dlqId}`);
        f.dlq.delete(dlqId);
      },
    });
    expect(parseTakeoverRedriveArgs(['--job', legacyId]).filter).toEqual({ jobId: legacyId });
    expect(parseTakeoverRedriveArgs(['--job', dlqId]).filter).toEqual({ jobId: dlqId });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { jobId: legacyId },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => i.action)).toEqual(['enqueued']);
    expect(r.items[0]).toMatchObject({ jobId: legacyId, dlqJobId: dlqId, kind: 'push_devices' });
    expect(f.calls).toEqual([`enqueue ${legacyId}`, `remove ${dlqId}`]);
  });

  it('rejects a #469-format id that does not match its payload, and a legacy id for a newer kind', async () => {
    const f = fakeQueues();
    const other = legacyTakeoverFollowUpJobId(job('u2', 'realtime'))!;
    const dlqId = takeoverDeadLetterJobId(other);
    f.dlq.set(dlqId, {
      id: dlqId,
      data: { ...job('u1', 'realtime'), jobId: other, attemptsMade: 6 },
      remove: async () => {
        f.calls.push(`remove ${dlqId}`);
      },
    });
    const r = await redriveTakeoverFollowUpDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => i.action)).toEqual(['invalid_payload']);
    expect(f.calls).toEqual([]);
    expect(legacyTakeoverFollowUpJobId(job('u1', 'set_password_mail'))).toBeUndefined();
    expect(() =>
      parseTakeoverRedriveArgs(['--job', `takeover_set_password_mail_${'a'.repeat(40)}`]),
    ).toThrow('--job needs');
  });
});

describe('takeover:redrive CLI', () => {
  it('needs REDIS_URL, validates the prefix, and masks URL credentials', async () => {
    const io = { out: () => {}, ask: async () => 'no' };
    await expect(main({}, ['--all'], io)).rejects.toThrow('REDIS_URL is required');
    await expect(
      main({ REDIS_URL: 'redis://x', AUTH_MAIL_QUEUE_PREFIX: 'bad prefix!' }, ['--all'], io),
    ).rejects.toThrow('AUTH_MAIL_QUEUE_PREFIX has invalid characters');
    await expect(main({ REDIS_URL: 'redis://x' }, ['--nope'], io)).rejects.toThrow(
      'unknown argument',
    );
    expect(redactUrls('connect to rediss://default:s3cret@cache:6380 failed')).toBe(
      'connect to rediss://***@cache:6380 failed',
    );
    expect(redactUrls('redis://cache:6379 refused')).toBe('redis://cache:6379 refused');
  });
});
