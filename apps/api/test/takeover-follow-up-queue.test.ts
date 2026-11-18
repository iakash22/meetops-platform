/**
 * #463 review: account-takeover follow-ups that still fail in-request go to a durable BullMQ job (one per user and
 * kind) instead of in-process timers. Redis-free: fake producer / DLQ; the live restart test is in
 * takeover-follow-up-queue.live.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { DelayedError, UnrecoverableError, type JobsOptions } from 'bullmq';
import { AuthService } from '../src/modules/auth/application/auth.service.js';
import type { TakeoverFollowUpJob } from '../src/modules/auth/domain/takeover-follow-up.js';
import {
  BullMqTakeoverFollowUpQueue,
  createTakeoverFollowUpProcessor,
  handleTakeoverFollowUpFailure,
  InvalidTakeoverFollowUpJobError,
  TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS,
  TAKEOVER_FOLLOW_UP_JOB_OPTIONS,
  TAKEOVER_FOLLOW_UP_RETHROW_NAME,
  takeoverFollowUpJobId,
  type TakeoverDeadLetter,
  type TakeoverFollowUpProducer,
} from '../src/modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';
import type { AuthMailJob, AuthMailQueue } from '../src/modules/auth/domain/mail-jobs.js';
import {
  BullMqAuthMailQueue,
  type AuthMailProducer,
} from '../src/modules/auth/infrastructure/mail-queue/bullmq-mail-queue.js';
import { InMemoryOneTimeTokenRepository } from '../src/modules/auth/infrastructure/in-memory-one-time-token.repository.js';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service.js';
import { systemClock } from '../src/shared/ports.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
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
  it('is deterministic per user, kind and time bucket, BullMQ-safe, and carries no raw id', () => {
    // Align to a bucket start so now + BUCKET_MS - 1 is still the same bucket.
    const now = 2 * TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS;
    const a = takeoverFollowUpJobId({ userId: USER, kind: 'push_devices' }, now);
    expect(a).toBe(takeoverFollowUpJobId({ userId: USER, kind: 'push_devices' }, now));
    expect(a).toBe(
      takeoverFollowUpJobId(
        { userId: USER, kind: 'push_devices' },
        now + TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS - 1,
      ),
    );
    expect(a).toMatch(/^takeover_push_devices_[0-9]{1,12}_[0-9a-f]{40}$/);
    expect(a).not.toContain(':');
    expect(a).not.toContain(USER);
    expect(takeoverFollowUpJobId({ userId: USER, kind: 'realtime' }, now)).not.toBe(a);
    expect(takeoverFollowUpJobId({ userId: `${USER}x`, kind: 'push_devices' }, now)).not.toBe(a);
    expect(
      takeoverFollowUpJobId(
        { userId: USER, kind: 'push_devices' },
        now + TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS,
      ),
    ).not.toBe(a);
  });

  it('enqueues ids only, with the deterministic job id and bounded attempts + backoff', async () => {
    const producer = new DedupingProducer();
    const q = new BullMqTakeoverFollowUpQueue(producer, systemClock);
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

  it('takes the job id bucket from the injected clock, not Date.now()', async () => {
    const producer = new DedupingProducer();
    const fixed = TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS * 3;
    const q = new BullMqTakeoverFollowUpQueue(producer, { now: () => new Date(fixed) });
    await q.enqueue({ userId: USER, kind: 'realtime' });
    expect([...producer.jobs.keys()]).toEqual([
      takeoverFollowUpJobId({ userId: USER, kind: 'realtime' }, fixed),
    ]);
  });

  it('is idempotent: enqueueing the same user + kind twice keeps one job', async () => {
    vi.useFakeTimers({ now: 0 });
    const producer = new DedupingProducer();
    const q = new BullMqTakeoverFollowUpQueue(producer, systemClock);
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    expect(producer.adds).toBe(2);
    expect(producer.jobs.size).toBe(1);
    vi.useRealTimers();
  });

  it('a later time bucket gets a new job id, so a failed job does not block a new takeover', async () => {
    vi.useFakeTimers({ now: 0 });
    const producer = new DedupingProducer();
    const q = new BullMqTakeoverFollowUpQueue(producer, systemClock);
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    const first = [...producer.jobs.keys()][0]!;
    vi.setSystemTime(TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS);
    await q.enqueue({ userId: USER, kind: 'push_devices' });
    expect(producer.jobs.size).toBe(2);
    expect([...producer.jobs.keys()]).toEqual([
      first,
      takeoverFollowUpJobId(
        { userId: USER, kind: 'push_devices' },
        TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS,
      ),
    ]);
    expect(first).toBe(takeoverFollowUpJobId({ userId: USER, kind: 'push_devices' }, 0));
    vi.useRealTimers();
  });

  it('rejects invalid jobs and surfaces producer failures (the caller falls back)', async () => {
    const q = new BullMqTakeoverFollowUpQueue(new DedupingProducer(), systemClock);
    await expect(
      q.enqueue({ userId: USER, kind: 'nope' } as unknown as TakeoverFollowUpJob),
    ).rejects.toThrow('invalid takeover follow-up job');
    await expect(q.enqueue({ userId: 'a:b@c', kind: 'realtime' })).rejects.toThrow();
    const down = new BullMqTakeoverFollowUpQueue(
      { add: () => Promise.reject(new Error('ECONNREFUSED')) },
      systemClock,
    );
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
    expect((err as Error).name).toBe('TypeError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: 'auth.takeover.follow_up_retry_failed',
      kind: 'push_devices',
      attempt: 3,
    });
  });

  it('never rethrows under a BullMQ control-flow name (DelayedError, UnrecoverableError)', async () => {
    for (const thrown of [new DelayedError('x'), new UnrecoverableError('y')]) {
      const p = createTakeoverFollowUpProcessor({
        runTakeoverFollowUp: async () => {
          throw thrown;
        },
      });
      const err = (await p(job({ userId: USER, kind: 'push_devices' })).catch(
        (e: Error) => e,
      )) as Error;
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err).not.toBeInstanceOf(DelayedError);
      expect(err.name).toBe(TAKEOVER_FOLLOW_UP_RETHROW_NAME);
      expect(err.message).toBe(`takeover follow-up failed (${thrown.name})`);
    }
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

  it('records the original error class on the DLQ entry, not a generic Error wrapper', async () => {
    const q = dlq();
    const warn = vi.fn();
    const p = createTakeoverFollowUpProcessor(
      {
        runTakeoverFollowUp: async () => {
          throw new TypeError('postgres://user:secret@db/x refused');
        },
      },
      { error: vi.fn(), warn },
    );
    const err = await p(failed(5)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('TypeError');
    expect(
      await handleTakeoverFollowUpFailure(failed(6), err as Error, {
        dlq: q,
        log: { error: vi.fn() },
        now: () => new Date('2026-11-11T00:00:00Z'),
      }),
    ).toBe(true);
    expect(q.added[0]!.data.errorType).toBe('TypeError');
    expect(JSON.stringify(q.added)).not.toContain('secret');
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

describe('set_password_mail durable retry (idempotent, #496 review)', () => {
  const CLAIM = new Date('2026-11-12T00:00:00Z');
  type U = {
    id: string;
    passwordHash: string;
    emailVerifiedAt: Date | null;
    deletedAt: Date | null;
  };

  function setup(opts: { user?: Partial<U> | null; failMail?: () => boolean } = {}) {
    let now = new Date(CLAIM.getTime() + 60_000);
    let n = 0;
    const user: U | null =
      opts.user === null
        ? null
        : { id: USER, passwordHash: '', emailVerifiedAt: CLAIM, deletedAt: null, ...opts.user };
    const tokens = new InMemoryOneTimeTokenRepository();
    const mailed: AuthMailJob[] = [];
    const mailQueue: AuthMailQueue = {
      enqueue: async (job) => {
        mailed.push(job);
      },
      enqueueOrThrow: async (job) => {
        if (opts.failMail?.()) throw new Error('ECONNREFUSED');
        mailed.push(job);
      },
    };
    const errors: Record<string, unknown>[] = [];
    const auth = new AuthService({
      clock: { now: () => now },
      ids: { next: () => `tok-${++n}` },
      tokens: { hash: (v: string) => `h:${v}`, generate: () => `plain-${n}` },
      passwordResetTtlMs: 3_600_000,
      oneTimeTokens: tokens,
      users: { findById: async (id: string) => (user && id === user.id ? { ...user } : null) },
      mailQueue,
      log: { error: (obj: Record<string, unknown>) => errors.push(obj) },
    } as unknown as ConstructorParameters<typeof AuthService>[0]);
    const run = () => auth.runTakeoverFollowUp({ userId: USER, kind: 'set_password_mail' });
    const unused = () => [...tokens.items.values()].filter((t) => !t.usedAt);
    const tick = (ms: number) => {
      now = new Date(now.getTime() + ms);
    };
    return { run, tokens, mailed, user, unused, tick, errors };
  }

  it('two runs give exactly one mail (the second sees the unused post-claim token)', async () => {
    const t = setup();
    await t.run();
    await t.run();
    expect(t.mailed).toEqual([{ kind: 'password_reset', tokenId: 'tok-1' }]);
    expect(t.unused().map((x) => x.id)).toEqual(['tok-1']);
  });

  it('is a no-op once the user has set a password since the claim', async () => {
    const t = setup({ user: { passwordHash: 'argon2id$set-after-claim' } });
    await t.run();
    expect(t.mailed).toEqual([]);
    expect(t.tokens.items.size).toBe(0);
  });

  it('does not void a reset link the user requested after the claim (no-op)', async () => {
    const t = setup();
    await t.tokens.create({
      id: 'user-requested',
      userId: USER,
      purpose: 'password_reset',
      tokenHash: 'h:x',
      expiresAt: new Date(CLAIM.getTime() + 3_600_000),
      usedAt: null,
      createdAt: new Date(CLAIM.getTime() + 1_000),
    });
    await t.run();
    expect(t.mailed).toEqual([]);
    expect(t.unused().map((x) => x.id)).toEqual(['user-requested']);
  });

  it('voids leftover pre-claim or expired tokens and mints one', async () => {
    const t = setup();
    await t.tokens.create({
      id: 'pre-claim',
      userId: USER,
      purpose: 'password_reset',
      tokenHash: 'h:old',
      expiresAt: new Date(CLAIM.getTime() + 3_600_000),
      usedAt: null,
      createdAt: new Date(CLAIM.getTime() - 1_000),
    });
    await t.run();
    expect(t.mailed).toEqual([{ kind: 'password_reset', tokenId: 'tok-1' }]);
    expect(t.unused().map((x) => x.id)).toEqual(['tok-1']);
    // Once that link has expired unused, a later run sends a fresh one.
    t.tick(3_600_001);
    await t.run();
    expect(t.mailed.map((m) => (m as { tokenId: string }).tokenId)).toEqual(['tok-1', 'tok-2']);
  });

  it('a mail queue failure voids the fresh token and rethrows, so the next attempt sends one mail', async () => {
    let down = true;
    const t = setup({ failMail: () => down });
    await expect(t.run()).rejects.toThrow('ECONNREFUSED');
    expect(t.mailed).toEqual([]);
    expect(t.unused()).toEqual([]);
    down = false;
    await t.run();
    await t.run();
    expect(t.mailed).toEqual([{ kind: 'password_reset', tokenId: 'tok-2' }]);
  });

  it('is a no-op without a live, claimed user', async () => {
    for (const user of [null, { emailVerifiedAt: null }, { deletedAt: new Date() }]) {
      const t = setup({ user });
      await t.run();
      expect(t.mailed).toEqual([]);
      expect(t.tokens.items.size).toBe(0);
    }
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
      { takeoverFollowUps: new BullMqTakeoverFollowUpQueue(producer, systemClock) },
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

  /**
   * #496 review BLOCKER: the real BullMqAuthMailQueue (whose `enqueue` swallows errors) with a producer that fails for
   * password_reset. Other kinds are recorded; the verification link is rebuilt from the token the API generated.
   */
  function failingMailQueue(poison: string) {
    const generated: string[] = [];
    const real = new CryptoTokenService();
    const tokens = {
      generate: () => {
        const v = real.generate();
        generated.push(v);
        return v;
      },
      hash: (v: string) => real.hash(v),
    };
    const verifyTokens: string[] = [];
    let failReset = false;
    const producer: AuthMailProducer = {
      add: async (name) => {
        if (name === 'email_verification') verifyTokens.push(generated.at(-1)!);
        if (failReset && name === 'password_reset') throw new TypeError(poison);
        return {};
      },
    };
    const mailLog: Record<string, unknown>[] = [];
    const mailQueue = new BullMqAuthMailQueue(producer, systemClock, {
      error: (obj) => mailLog.push(obj),
      warn: (obj) => mailLog.push(obj),
    });
    return {
      mailQueue,
      tokens,
      mailLog,
      verifyToken: () => verifyTokens.at(-1)!,
      failResets: () => {
        failReset = true;
      },
    };
  }

  it('a BullMQ mail enqueue failure still returns 204, logs no PII, and queues the durable follow-up', async () => {
    const email = 'mailfail1@example.com';
    const poison = `redis rejected ${email} token=super-secret-token user=Mallory`;
    const m = failingMailQueue(poison);
    const producer = new DedupingProducer();
    const errors: { obj: Record<string, unknown>; msg: string }[] = [];
    const app: App = await buildApp({
      mailQueue: m.mailQueue,
      tokens: m.tokens,
      takeoverFollowUps: new BullMqTakeoverFollowUpQueue(producer, systemClock),
      authLog: { error: (obj, msg) => errors.push({ obj, msg }) },
      scheduleRetry: () => {
        throw new Error('in-process fallback must not run when the durable enqueue succeeds');
      },
    });
    const squatter = new Client(app);
    expect(
      (await squatter.post('/auth/signup', { name: 'Mallory', email, password: PASSWORD }))
        .statusCode,
    ).toBe(202);
    m.failResets();
    const v = await new Client(app).post('/auth/verify-email', { token: m.verifyToken() });
    expect(v.statusCode).toBe(204);
    expect(v.headers['x-meetops-verify-outcome']).toBe('password_reset');
    const jobs = [...producer.jobs.values()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ userId: expect.any(String), kind: 'set_password_mail' });
    expect(Object.keys(jobs[0]!.data).sort()).toEqual(['kind', 'userId']);
    expect(errors.map((e) => e.obj.event)).toEqual([
      'auth.takeover.set_password_mail_enqueue_failed',
    ]);
    expect(errors[0]!.obj).toMatchObject({
      userId: expect.any(String),
      err: { type: 'TypeError' },
    });
    expect(m.mailLog).toEqual([
      expect.objectContaining({ kind: 'password_reset', err: { type: 'TypeError' } }),
    ]);
    const dumped = JSON.stringify([errors, m.mailLog]);
    expect(dumped).not.toContain(email);
    expect(dumped).not.toContain('super-secret-token');
    expect(dumped).not.toContain('Mallory');
    expect(dumped).not.toContain(poison);
    await app.close();
  });

  it('records set_password_mail in followUpFailed on the auth.email.verify audit', async () => {
    const email = 'mailfail3@example.com';
    const m = failingMailQueue('down');
    const audit = new InMemoryAuditLog();
    const app: App = await buildApp({
      mailQueue: m.mailQueue,
      tokens: m.tokens,
      takeoverFollowUps: new BullMqTakeoverFollowUpQueue(new DedupingProducer(), systemClock),
      authLog: { error: () => {} },
      audit,
    });
    expect(
      (
        await new Client(app).post('/auth/signup', {
          name: 'Mallory',
          email,
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(202);
    m.failResets();
    const v = await new Client(app).post('/auth/verify-email', { token: m.verifyToken() });
    expect(v.statusCode).toBe(204);
    const verify = audit.events.find((a) => a.action === 'auth.email.verify');
    expect(verify?.metadata).toMatchObject({
      proof: 'mailbox',
      followUpFailed: ['set_password_mail'],
    });
    await app.close();
  });

  it('a failed durable retry enqueue is logged and verify still returns 204', async () => {
    const email = 'mailfail2@example.com';
    const poison = `redis rejected ${email} token=another-secret-token user=Mallory`;
    const m = failingMailQueue(poison);
    const errors: Record<string, unknown>[] = [];
    const scheduled: number[] = [];
    const app: App = await buildApp({
      mailQueue: m.mailQueue,
      tokens: m.tokens,
      takeoverFollowUps: {
        enqueue: () => Promise.reject(new Error('ECONNREFUSED')),
      },
      authLog: { error: (obj) => errors.push(obj) },
      scheduleRetry: (_run, delayMs) => scheduled.push(delayMs),
    });
    const squatter = new Client(app);
    expect(
      (await squatter.post('/auth/signup', { name: 'Mallory', email, password: PASSWORD }))
        .statusCode,
    ).toBe(202);
    m.failResets();
    const v = await new Client(app).post('/auth/verify-email', { token: m.verifyToken() });
    expect(v.statusCode).toBe(204);
    expect(errors.map((e) => e.event)).toEqual([
      'auth.takeover.set_password_mail_enqueue_failed',
      'auth.takeover.follow_up_enqueue_failed',
    ]);
    expect(errors[1]).toMatchObject({ steps: ['set_password_mail'], err: 'Error' });
    expect(scheduled).toEqual([5_000]);
    const dumped = JSON.stringify(errors);
    expect(dumped).not.toContain(email);
    expect(dumped).not.toContain('another-secret-token');
    expect(dumped).not.toContain('Mallory');
    await app.close();
  });
});
