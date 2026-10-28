import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError, type JobsOptions } from 'bullmq';
import { createServer } from '../src/server.js';
import { defaultModuleDeps } from '../src/modules/index.js';
import { AuthMailJobHandler } from '../src/modules/auth/application/auth-mail.handler.js';
import {
  AUTH_MAIL_JOB_OPTIONS,
  AUTH_MAIL_DEDUPE_WINDOW_MS,
  assertNoPiiInJobId,
  authMailJobId,
  BullMqAuthMailQueue,
  createAuthMailProcessor,
  type AuthMailProducer,
} from '../src/modules/auth/infrastructure/mail-queue/bullmq-mail-queue.js';
import { loadAuthMailQueueEnv } from '../src/modules/auth/infrastructure/mail-queue/env.js';
import { RecordingMailTransport, type AuthMailJob } from '../src/modules/auth/domain/mail-jobs.js';
import { Client, fakeHasher, PASSWORD } from './helpers.js';

/** Fake BullMQ producer: ignores a duplicate jobId like Queue#add does. */
class FakeProducer implements AuthMailProducer {
  readonly jobs = new Map<string, { name: string; data: AuthMailJob; opts: JobsOptions }>();
  fail: Error | null = null;
  async add(name: string, data: AuthMailJob, opts: JobsOptions) {
    if (this.fail) throw this.fail;
    if (!this.jobs.has(opts.jobId!)) this.jobs.set(opts.jobId!, { name, data, opts });
    return { id: opts.jobId };
  }
}

const at = (iso: string) => ({ now: () => new Date(iso) });
const log = () => ({ warn: vi.fn(), error: vi.fn() });
const EMAIL = 'pii.person@example.test';

describe('auth mail job ids', () => {
  const now = new Date('2026-10-29T00:00:00Z');
  const jobs: AuthMailJob[] = [
    { kind: 'email_verification', tokenId: 't1' },
    { kind: 'password_reset', tokenId: 't2' },
    { kind: 'account_exists', userId: 'u1' },
    { kind: 'login_lockout', userId: 'u1' },
    { kind: 'invitation', organizationId: 'o1', invitationId: 'i1' },
    { kind: 'password_changed', userId: 'u1', changedAt: now.toISOString() },
  ];

  it('are deterministic, distinct per subject and shaped authmail_<kind>_<hex>', () => {
    const ids = jobs.map((j) => authMailJobId(j, now));
    expect(ids).toEqual(jobs.map((j) => authMailJobId(j, new Date(now.getTime() + 1000))));
    expect(new Set(ids).size).toBe(jobs.length);
    for (const id of ids) expect(id).toMatch(/^authmail_[a-z_]+_[0-9a-f]{40}$/);
    expect(authMailJobId({ kind: 'email_verification', tokenId: 't9' }, now)).not.toBe(ids[0]);
  });

  it('user-keyed notices roll over per dedupe window', () => {
    const j: AuthMailJob = { kind: 'account_exists', userId: 'u1' };
    const later = new Date(now.getTime() + AUTH_MAIL_DEDUPE_WINDOW_MS);
    expect(authMailJobId(j, later)).not.toBe(authMailJobId(j, now));
  });

  it('timing-parity jobs without a subject get no id', () => {
    expect(authMailJobId({ kind: 'password_reset', tokenId: null }, now)).toBeNull();
    expect(authMailJobId({ kind: 'login_lockout', userId: null }, now)).toBeNull();
  });

  it('never contain PII, even when ids themselves look like PII', () => {
    const tricky: AuthMailJob = { kind: 'account_exists', userId: EMAIL };
    const id = authMailJobId(tricky, now)!;
    expect(id).not.toContain('@');
    expect(id).not.toContain('pii');
    expect(id).not.toContain('example');
    for (const bad of [
      `authmail_invitation_${EMAIL}`,
      'authmail_x_tok=abc',
      `${'a'.repeat(40)}`,
      'a:b',
    ])
      expect(() => assertNoPiiInJobId(bad)).toThrow();
  });
});

describe('BullMqAuthMailQueue', () => {
  it('enqueues a minimal ids-only payload with retries + backoff', async () => {
    const p = new FakeProducer();
    const q = new BullMqAuthMailQueue(p, at('2026-10-29T00:00:00Z'));
    await q.enqueue({
      kind: 'invitation',
      organizationId: 'o1',
      invitationId: 'i1',
      extra: EMAIL,
    } as never);
    const [job] = [...p.jobs.values()];
    expect(job!.name).toBe('invitation');
    expect(job!.data).toEqual({ kind: 'invitation', organizationId: 'o1', invitationId: 'i1' });
    expect(JSON.stringify(job)).not.toContain('@');
    expect(job!.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
    expect(job!.opts.attempts).toBe(AUTH_MAIL_JOB_OPTIONS.attempts);
  });

  it('is idempotent: the same job enqueued twice is stored once', async () => {
    const p = new FakeProducer();
    const q = new BullMqAuthMailQueue(p, at('2026-10-29T00:00:00Z'));
    await q.enqueue({ kind: 'email_verification', tokenId: 't1' });
    await q.enqueue({ kind: 'email_verification', tokenId: 't1' });
    await q.enqueue({ kind: 'password_reset', tokenId: null });
    expect(p.jobs.size).toBe(1);
  });

  it('never throws when Redis is down and logs no message text', async () => {
    const p = new FakeProducer();
    p.fail = new Error(`ECONNREFUSED for ${EMAIL}`);
    const l = log();
    const q = new BullMqAuthMailQueue(p, at('2026-10-29T00:00:00Z'), l);
    await expect(q.enqueue({ kind: 'account_exists', userId: 'u1' })).resolves.toBeUndefined();
    expect(l.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(l.error.mock.calls)).not.toContain(EMAIL);
  });
});

describe('auth mail worker processor', () => {
  const job = (data: unknown, attemptsMade = 0) => ({
    id: 'authmail_x',
    data: data as AuthMailJob,
    attemptsMade,
    opts: { attempts: 3 },
  });

  it('retries transient failures with a sanitized error, then logs the final failure', async () => {
    const l = log();
    const handle = vi.fn(async () => {
      throw Object.assign(new Error(`421 try later ${EMAIL}`), { responseCode: 421 });
    });
    const run = createAuthMailProcessor({ handle }, l);
    const err = await run(job({ kind: 'account_exists', userId: 'u1' })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).not.toContain(EMAIL);
    expect(l.warn).toHaveBeenCalledOnce();
    await run(job({ kind: 'account_exists', userId: 'u1' }, 2)).catch(() => {});
    expect(l.error).toHaveBeenCalledOnce();
    expect(JSON.stringify([l.warn.mock.calls, l.error.mock.calls])).not.toContain(EMAIL);
  });

  it('fails permanent errors and invalid payloads without retry', async () => {
    const run = createAuthMailProcessor({
      handle: async () => {
        throw Object.assign(new Error('550 rejected'), { responseCode: 550 });
      },
    });
    await expect(run(job({ kind: 'account_exists', userId: 'u1' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(run(job({ kind: 'nope' }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('end to end: signup enqueues ids only; the worker sends the verification mail', async () => {
    const p = new FakeProducer();
    const mail = new RecordingMailTransport();
    const deps = defaultModuleDeps(
      { hasher: fakeHasher, mailTransport: mail },
      { nodeEnv: 'test', mailQueueEnv: { AUTH_MAIL_QUEUE: 'bullmq' }, mailQueueProducer: p },
    );
    expect(deps.mailQueue).toBeInstanceOf(BullMqAuthMailQueue);
    expect(deps.authMailWorker).toBeUndefined();
    const app = createServer({ deps });
    await app.ready();
    const c = new Client(app as never);
    const r = await c.post('/auth/signup', { name: 'Pat', email: EMAIL, password: PASSWORD });
    expect(r.statusCode).toBeLessThan(300);
    expect(mail.sent).toHaveLength(0);
    expect(p.jobs.size).toBe(1);
    const [id, queued] = [...p.jobs.entries()][0]!;
    expect(id + JSON.stringify(queued)).not.toMatch(/@|Pat|token=/);
    const run = createAuthMailProcessor(new AuthMailJobHandler({ ...deps, transport: mail }));
    await run({ id, data: queued!.data, attemptsMade: 0, opts: queued!.opts });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: EMAIL, template: 'email_verification' });
    expect(mail.lastToken(EMAIL, 'email_verification')).toBeTruthy();
    await app.close();
  });
});

describe('auth mail queue selection', () => {
  it('defaults to inline and validates variables', () => {
    expect(loadAuthMailQueueEnv({})).toEqual({
      mode: 'inline',
      prefix: undefined,
      workerEnabled: true,
      concurrency: 5,
    });
    expect(() => loadAuthMailQueueEnv({ AUTH_MAIL_QUEUE: 'sqs' })).toThrow(/AUTH_MAIL_QUEUE/);
    expect(() => loadAuthMailQueueEnv({ AUTH_MAIL_QUEUE_PREFIX: 'a b' })).toThrow();
  });

  it('bullmq refuses non-SMTP providers and a missing REDIS_URL', () => {
    const env = {
      nodeEnv: 'development',
      mailQueueEnv: { AUTH_MAIL_QUEUE: 'bullmq' },
      redisUrl: 'redis://127.0.0.1:1',
    };
    expect(() =>
      defaultModuleDeps(
        { hasher: fakeHasher },
        {
          ...env,
          emailEnv: { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'x', EMAIL_FROM: 'a <a@b.c>' },
        },
      ),
    ).toThrow(/EMAIL_PROVIDER=smtp/);
    expect(() =>
      defaultModuleDeps({ hasher: fakeHasher }, { ...env, redisUrl: undefined }),
    ).toThrow(/REDIS_URL/);
    const deps = defaultModuleDeps(
      { hasher: fakeHasher },
      {
        ...env,
        emailEnv: {
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'localhost',
          SMTP_PORT: '1025',
          EMAIL_FROM: 'a <a@b.c>',
        },
      },
    );
    expect(deps.mailQueue).toBeInstanceOf(BullMqAuthMailQueue);
    expect(deps.authMailWorker).toMatchObject({ concurrency: 5 });
  });
});
