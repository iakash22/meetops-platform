/**
 * #463 review: account-takeover follow-ups that still fail in-request go to a durable BullMQ job (one per user and
 * kind) instead of in-process timers. Redis-free: fake producer / DLQ; the live restart test is in
 * takeover-follow-up-queue.live.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type JobsOptions } from 'bullmq';
import { AuthService } from '../src/modules/auth/application/auth.service.js';
import type { TakeoverFollowUpJob } from '../src/modules/auth/domain/takeover-follow-up.js';
import {
  BullMqTakeoverFollowUpQueue,
  createTakeoverFollowUpProcessor,
  handleTakeoverFollowUpFailure,
  InvalidTakeoverFollowUpJobError,
  TAKEOVER_FOLLOW_UP_JOB_OPTIONS,
  takeoverFollowUpJobId,
  type TakeoverDeadLetter,
  type TakeoverFollowUpProducer,
} from '../src/modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';
import { InMemoryMembershipRepository } from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, Client, PASSWORD, type App } from './helpers.js';

const USER = '0b8f2c1e-4c1a-4f7e-9d2b-1a2b3c4d5e6f';

/** Behaves like BullMQ Queue#add for custom job ids: a second add with a live id is a no-op. */
class DedupingProducer implements TakeoverFollowUpProducer {
  readonly jobs = new Map<string, { name: string; data: TakeoverFollowUpJob; opts: JobsOptions }>();
  adds = 0;
  async add(name: string, data: TakeoverFollowUpJob, opts: JobsOptions) {
    this.adds++;
    if (!this.jobs.has(opts.jobId!)) this.jobs.set(opts.jobId!, { name, data, opts });
    return {};
  }
}

describe('takeover follow-up job id and producer', () => {
  it('is deterministic per user and kind, BullMQ-safe, and carries no raw id', () => {
    const a = takeoverFollowUpJobId({ userId: USER, kind: 'push_devices' });
    expect(a).toBe(takeoverFollowUpJobId({ userId: USER, kind: 'push_devices' }));
    expect(a).toMatch(/^takeover_push_devices_[0-9a-f]{40}$/);
    expect(a).not.toContain(':');
    expect(a).not.toContain(USER);
    expect(takeoverFollowUpJobId({ userId: USER, kind: 'realtime' })).not.toBe(a);
    expect(takeoverFollowUpJobId({ userId: `${USER}x`, kind: 'push_devices' })).not.toBe(a);
  });

  it('enqueues ids only, with the deterministic job id and bounded attempts + backoff', async () => {
    const producer = new DedupingProducer();
    const q = new BullMqTakeoverFollowUpQueue(producer);
    await q.enqueue({
      userId: USER,
      kind: 'extension_tokens',
      email: 'victim@example.com',
    } as TakeoverFollowUpJob);
    expect(producer.jobs.size).toBe(1);
    const [jobId, job] = [...producer.jobs.entries()][0]!;
    expect(jobId).toBe(takeoverFollowUpJobId({ userId: USER, kind: 'extension_tokens' }));
    expect(job.name).toBe('extension_tokens');
    expect(job.data).toEqual({ userId: USER, kind: 'extension_tokens' });
    expect(job.opts).toMatchObject({
      jobId,
      attempts: 6,
      backoff: { type: 'exponential', delay: 5_000 },
      delay: 5_000,
      removeOnComplete: true,
    });
    expect(TAKEOVER_FOLLOW_UP_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });

  it('is idempotent: enqueueing the same user + kind twice keeps one job', async () => {
    const producer = new DedupingProducer();
    const q = new BullMqTakeoverFollowUpQueue(producer);
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    expect(producer.adds).toBe(2);
    expect(producer.jobs.size).toBe(1);
  });

  it('rejects invalid jobs and surfaces producer failures (the caller falls back)', async () => {
    const q = new BullMqTakeoverFollowUpQueue(new DedupingProducer());
    await expect(
      q.enqueue({ userId: USER, kind: 'nope' } as unknown as TakeoverFollowUpJob),
    ).rejects.toThrow('invalid takeover follow-up job');
    await expect(q.enqueue({ userId: 'a:b@c', kind: 'realtime' })).rejects.toThrow();
    const down = new BullMqTakeoverFollowUpQueue({
      add: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(down.enqueue({ userId: USER, kind: 'realtime' })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('takeover follow-up processor', () => {
  const job = (data: unknown, attemptsMade = 0) => ({
    id: 'takeover_push_devices_x',
    data: data as TakeoverFollowUpJob,
    attemptsMade,
    opts: { attempts: 6 },
  });

  it('runs the follow-up with the minimal payload', async () => {
    const runner = { runTakeoverFollowUp: vi.fn(async () => {}) };
    await createTakeoverFollowUpProcessor(runner)(
      job({ userId: USER, kind: 'push_devices', extra: 'x' }),
    );
    expect(runner.runTakeoverFollowUp).toHaveBeenCalledWith({ userId: USER, kind: 'push_devices' });
  });

  it('fails an invalid payload without retries', async () => {
    const runner = { runTakeoverFollowUp: vi.fn(async () => {}) };
    const p = createTakeoverFollowUpProcessor(runner);
    await expect(p(job({ userId: USER, kind: 'drop_tables' }))).rejects.toBeInstanceOf(
      InvalidTakeoverFollowUpJobError,
    );
    await expect(p(job(null))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(runner.runTakeoverFollowUp).not.toHaveBeenCalled();
  });

  it('rethrows a sanitized error so BullMQ retries (no message stored in Redis)', async () => {
    const warn = vi.fn();
    const p = createTakeoverFollowUpProcessor(
      {
        runTakeoverFollowUp: async () => {
          throw new TypeError('postgres://user:secret@db/x refused');
        },
      },
      { error: vi.fn(), warn },
    );
    const err = await p(job({ userId: USER, kind: 'push_devices' }, 2)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('takeover follow-up failed (TypeError)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: 'auth.takeover.follow_up_retry_failed',
      kind: 'push_devices',
      attempt: 3,
    });
  });
});

describe('takeover follow-up retries and DLQ', () => {
  const dlq = () => {
    const added: { name: string; data: TakeoverDeadLetter; opts: JobsOptions }[] = [];
    return {
      added,
      add: async (name: string, data: TakeoverDeadLetter, opts: JobsOptions) => {
        added.push({ name, data, opts });
      },
    };
  };
  const failed = (attemptsMade: number) => ({
    id: 'takeover_push_devices_abc',
    data: { userId: USER, kind: 'push_devices' as const },
    attemptsMade,
    opts: { attempts: 6 },
  });

  it('does nothing while attempts remain (BullMQ retries with backoff)', async () => {
    const q = dlq();
    const log = { error: vi.fn() };
    expect(await handleTakeoverFollowUpFailure(failed(3), new Error('x'), { dlq: q, log })).toBe(
      false,
    );
    expect(q.added).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('dead-letters an exhausted job (ids only, never auto-removed) and logs follow_up_abandoned', async () => {
    const q = dlq();
    const log = { error: vi.fn() };
    const now = () => new Date('2026-11-11T00:00:00Z');
    expect(
      await handleTakeoverFollowUpFailure(failed(6), new Error('x'), { dlq: q, log, now }),
    ).toBe(true);
    expect(q.added).toEqual([
      {
        name: 'takeover_follow_up_dead_letter',
        data: {
          userId: USER,
          kind: 'push_devices',
          jobId: 'takeover_push_devices_abc',
          attemptsMade: 6,
          errorType: 'Error',
          failedAt: '2026-11-11T00:00:00.000Z',
        },
        opts: {
          jobId: 'dlq_takeover_push_devices_abc',
          removeOnComplete: false,
          removeOnFail: false,
        },
      },
    ]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.takeover.follow_up_abandoned',
        userId: USER,
        steps: ['push_devices'],
      }),
      expect.any(String),
    );
  });

  it('an unrecoverable failure is final at once; a failed DLQ write is logged, never thrown', async () => {
    const log = { error: vi.fn() };
    const broken = { add: () => Promise.reject(new Error('redis down')) };
    expect(
      await handleTakeoverFollowUpFailure(failed(1), new UnrecoverableError('x'), {
        dlq: broken,
        log,
      }),
    ).toBe(true);
    expect(log.error.mock.calls.map((c) => c[1])).toEqual([
      'takeover follow-up dead-letter enqueue failed',
      'account takeover follow-up still failing after deferred retries; dead-lettered',
    ]);
  });
});

describe('AuthService.runTakeoverFollowUp (the worker runner)', () => {
  const service = () => {
    const calls: string[] = [];
    const auth = new AuthService({
      revocations: {
        publish: async (e: { kind: string; reason?: string }) => {
          calls.push(`realtime:${e.kind}:${e.reason}`);
        },
      },
      extensionRevoker: {
        revokeForUser: async (
          u: string,
          reason: string,
          _o?: string,
          opts?: { propagate?: boolean },
        ) => {
          calls.push(`ext:${u}:${reason}:${String(opts?.propagate)}`);
        },
      },
      pushDeviceRevoker: {
        revokeForUser: async (u: string, org?: string | null) => {
          calls.push(`push:${u}:${String(org)}`);
        },
      },
    } as unknown as ConstructorParameters<typeof AuthService>[0]);
    return { auth, calls };
  };

  it('runs the realtime kick, the extension/desktop family revocation and the push-device delete', async () => {
    const { auth, calls } = service();
    await auth.runTakeoverFollowUp({ userId: USER, kind: 'realtime' });
    await auth.runTakeoverFollowUp({ userId: USER, kind: 'extension_tokens' });
    await auth.runTakeoverFollowUp({ userId: USER, kind: 'push_devices' });
    expect(calls).toEqual([
      'realtime:user:password_changed',
      `ext:${USER}:password_changed:true`,
      `push:${USER}:undefined`,
    ]);
  });

  it('is safe to run twice (a redelivered job)', async () => {
    const { auth, calls } = service();
    for (let i = 0; i < 2; i++)
      for (const kind of ['realtime', 'extension_tokens', 'push_devices'] as const)
        await auth.runTakeoverFollowUp({ userId: USER, kind });
    expect(calls).toHaveLength(6);
  });
});

describe('verify-email takeover hands failed revocations to the durable queue', () => {
  class Broken extends InMemoryMembershipRepository {
    broken = false;
    override async listByUser(userId: string) {
      if (this.broken) throw new Error('store down');
      return super.listByUser(userId);
    }
  }

  async function takeover(deps: Partial<ModuleDeps>, email: string) {
    const memberships = new Broken();
    const errors: Record<string, unknown>[] = [];
    const scheduled: number[] = [];
    const app: App = await buildApp({
      memberships,
      authLog: { error: (obj) => errors.push(obj) },
      scheduleRetry: (_run, delayMs) => scheduled.push(delayMs),
      ...deps,
    });
    const squatter = new Client(app);
    expect(
      (await squatter.post('/auth/signup', { name: 'Mallory', email, password: PASSWORD }))
        .statusCode,
    ).toBe(202);
    memberships.broken = true;
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token(email, 'email_verification')!,
    });
    return { app, v, errors, scheduled };
  }

  it('enqueues one job per failed kind (user id + kind only); no in-process timer', async () => {
    const producer = new DedupingProducer();
    const { app, v, errors, scheduled } = await takeover(
      { takeoverFollowUps: new BullMqTakeoverFollowUpQueue(producer) },
      'durable1@example.com',
    );
    expect(v.statusCode).toBe(204);
    expect(v.headers['x-meetops-verify-outcome']).toBe('password_reset');
    const jobs = [...producer.jobs.values()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ userId: expect.any(String), kind: 'push_devices' });
    expect(Object.keys(jobs[0]!.data).sort()).toEqual(['kind', 'userId']);
    expect(scheduled).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ event: 'auth.takeover.follow_up_failed', steps: ['push_devices'] }),
    ]);
    await app.close();
  });

  it('an enqueue failure is logged and falls back to the in-process retry; verify stays 204', async () => {
    const { app, v, errors, scheduled } = await takeover(
      {
        takeoverFollowUps: {
          enqueue: () => Promise.reject(new Error('ECONNREFUSED')),
        },
      },
      'durable2@example.com',
    );
    expect(v.statusCode).toBe(204);
    expect(errors.map((e) => e.event)).toEqual([
      'auth.takeover.follow_up_failed',
      'auth.takeover.follow_up_enqueue_failed',
    ]);
    expect(errors[1]).toMatchObject({ steps: ['push_devices'], err: 'Error' });
    expect(scheduled).toEqual([5_000]);
    await app.close();
  });
});
