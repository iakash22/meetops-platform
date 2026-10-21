import { describe, it, expect, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  createEmailProducer,
  createEmailProcessor,
  validateEmailJobPayload,
  DEFAULT_EMAIL_JOB_OPTIONS,
  EMAIL_QUEUE_NAME,
  ConsoleEmailService,
  type EmailJobPayload,
  type EmailJobResolver,
  type EmailService
} from '../src';

const payload = (over: Record<string, unknown> = {}): EmailJobPayload =>
  ({ jobVersion: 1, organizationId: 'org_1', idempotencyKey: 'invite-inv_9-v1', kind: 'send_email', templateId: 'invite', invitationId: 'inv_9', ...over }) as EmailJobPayload;
const userPayload = (templateId: string, over: Record<string, unknown> = {}) =>
  ({ jobVersion: 1, organizationId: 'org_1', idempotencyKey: `k-${templateId}`, kind: 'send_email', templateId, userId: 'usr_1', ...over }) as EmailJobPayload;

const resolver = (): EmailJobResolver & { resolve: ReturnType<typeof vi.fn> } => ({
  resolve: vi.fn(async (p: EmailJobPayload) =>
    p.templateId === 'invite'
      ? { templateId: 'invite' as const, to: { email: 'invitee@example.test', name: 'Ivy' }, variables: { inviterName: 'Bo', workspaceName: 'Acme', inviteUrl: 'https://app.test/invite?token=secret-tok' } }
      : null
  )
});

/** Fails if anything that looks like an email address, URL or token appears in the payload. */
function assertIdsOnly(data: unknown) {
  const json = JSON.stringify(data);
  expect(json).not.toMatch(/@/);
  expect(json).not.toMatch(/https?:|token|secret/i);
}

describe('email producer', () => {
  it('uses the contracts "email" queue name', () => {
    expect(EMAIL_QUEUE_NAME).toBe('email');
  });
  it('enqueues ids-only payloads with jobId = idempotencyKey and short retention', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'invite-inv_9-v1' });
    const id = await createEmailProducer({ add, close: vi.fn() }).enqueue(payload());
    expect(id).toBe('invite-inv_9-v1');
    const [name, data, opts] = add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe('send_email');
    assertIdsOnly(data);
    expect(opts).toMatchObject({ jobId: 'invite-inv_9-v1', attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
    expect(opts.removeOnComplete).toEqual({ count: 100, age: 3600 });
    expect(opts.removeOnFail).toEqual({ count: 500, age: 86400 });
    expect(DEFAULT_EMAIL_JOB_OPTIONS.removeOnFail.age).toBeLessThanOrEqual(86400);
  });
  it('jobId cannot be overridden', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'x' });
    await createEmailProducer({ add, close: vi.fn() }).enqueue(payload(), { jobId: 'other' });
    expect(add.mock.calls[0]?.[2]).toMatchObject({ jobId: 'invite-inv_9-v1' });
  });
  it('rejects payloads carrying addresses, links, tokens or extra fields', async () => {
    const add = vi.fn();
    const producer = createEmailProducer({ add, close: vi.fn() });
    const bad: unknown[] = [
      { ...payload(), to: [{ email: 'a@b.test' }] },
      { ...payload(), variables: { inviteUrl: 'https://x' } },
      payload({ invitationId: 'a@b.test' }),
      payload({ userId: 'u1' }),
      userPayload('reset_password', { invitationId: 'i1' }),
      userPayload('reset_password', { userId: undefined }),
      payload({ resetUrl: 'https://x/reset?token=abc' }),
      userPayload('task_assigned'),
      payload({ idempotencyKey: 'has:colon' }),
      payload({ templateId: 'nope' }),
      { ...payload(), jobVersion: 2 }
    ];
    for (const b of bad) await expect(producer.enqueue(b as EmailJobPayload)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(add).not.toHaveBeenCalled();
  });
  it('accepts userId templates (verify_email, reset_password, meeting_summary) per contracts v0.2', () => {
    for (const t of ['verify_email', 'reset_password', 'meeting_summary']) expect(() => validateEmailJobPayload(userPayload(t, { requestId: 'req_1' }))).not.toThrow();
  });
});

describe('email processor', () => {
  it('resolves recipient/links via resolver, renders and sends', async () => {
    const svc = new ConsoleEmailService();
    const r = resolver();
    const res = await createEmailProcessor(svc, r)({ id: '1', attemptsMade: 0, data: payload() });
    expect(r.resolve).toHaveBeenCalledWith(payload());
    expect(res.accepted).toEqual(['invitee@example.test']);
    expect(svc.sent[0]?.html).toContain('https://app.test/invite?token=secret-tok');
    expect(svc.sent[0]?.headers).toEqual({ 'X-MeetOps-Idempotency-Key': 'invite-inv_9-v1' });
  });
  it('fails permanently when recipient cannot be resolved or template mismatches', async () => {
    const svc = new ConsoleEmailService();
    await expect(createEmailProcessor(svc, resolver())({ id: '1', attemptsMade: 0, data: userPayload('verify_email') })).rejects.toBeInstanceOf(UnrecoverableError);
    const wrong: EmailJobResolver = { resolve: async () => ({ templateId: 'verify_email', to: 'a@x.test', variables: { name: 'a', verificationUrl: 'https://a.test', expiresInHours: 1 } }) };
    await expect(createEmailProcessor(svc, wrong)({ id: '1', attemptsMade: 0, data: payload() })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(svc.sent).toHaveLength(0);
  });
  it('rejects invalid payloads in the worker too', async () => {
    const r = resolver();
    await expect(createEmailProcessor(new ConsoleEmailService(), r)({ id: '1', attemptsMade: 0, data: { ...payload(), to: 'a@b.test' } as never })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(r.resolve).not.toHaveBeenCalled();
  });
  it('rethrows transient send/resolver errors so BullMQ retries', async () => {
    const svc: EmailService = { provider: 'mock', send: vi.fn().mockRejectedValue(new Error('ECONNRESET')), verify: vi.fn() };
    await expect(createEmailProcessor(svc, resolver())({ id: '1', attemptsMade: 0, data: payload() })).rejects.not.toBeInstanceOf(UnrecoverableError);
    const flaky: EmailJobResolver = { resolve: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(createEmailProcessor(new ConsoleEmailService(), flaky)({ id: '1', attemptsMade: 0, data: payload() })).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
  it('bad template variables from resolver are unrecoverable', async () => {
    const r: EmailJobResolver = { resolve: async () => ({ templateId: 'invite', to: 'a@x.test', variables: { inviterName: 'B', workspaceName: 'W', inviteUrl: 'javascript:alert(1)' } }) };
    await expect(createEmailProcessor(new ConsoleEmailService(), r)({ id: '1', attemptsMade: 0, data: payload() })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
