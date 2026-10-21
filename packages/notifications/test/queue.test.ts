import { describe, it, expect, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { EMAIL_QUEUE, EMAIL_JOB_RETENTION, EMAIL_TEMPLATE_IDS } from '@meetops/contracts';
import {
  templateNames,
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

const ORG = '0b6f3a52-6a0e-4d1f-9c55-2f4c6f0e1a01';
const INV = '7d9e2c1b-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
const USR = 'e4774cdd-a079-4f86-814e-8b9140bb6db4';

const payload = (over: Partial<EmailJobPayload> = {}): EmailJobPayload => ({
  jobVersion: 1,
  organizationId: ORG,
  idempotencyKey: 'invite-inv_9-v1',
  kind: 'send_email',
  templateId: 'invitation',
  recipient: { invitationId: INV },
  ...over
});

const resolver = (): EmailJobResolver & { resolve: ReturnType<typeof vi.fn> } => ({
  resolve: vi.fn(async (p: EmailJobPayload) =>
    p.templateId === 'invitation'
      ? { templateId: 'invitation' as const, to: { email: 'invitee@example.test', name: 'Ivy' }, variables: { inviterName: 'Bo', workspaceName: 'Acme', inviteUrl: 'https://app.test/invite?token=secret-tok' } }
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
  it('uses contract queue name, retention and template ids', () => {
    expect(EMAIL_QUEUE_NAME).toBe(EMAIL_QUEUE);
    expect(EMAIL_QUEUE_NAME).toBe('email');
    expect(DEFAULT_EMAIL_JOB_OPTIONS.removeOnComplete).toEqual(EMAIL_JOB_RETENTION.removeOnComplete);
    expect(DEFAULT_EMAIL_JOB_OPTIONS.removeOnFail).toEqual(EMAIL_JOB_RETENTION.removeOnFail);
    expect([...templateNames].sort()).toEqual([...EMAIL_TEMPLATE_IDS].sort());
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
      payload({ recipient: { userId: 'a@b.test' } }),
      payload({ recipient: { userId: USR, invitationId: INV } as never }),
      payload({ refs: { resetUrl: 'https://x/reset?token=abc' } }),
      payload({ idempotencyKey: 'has:colon' }),
      payload({ templateId: 'nope' as never }),
      { ...payload(), jobVersion: 2 },
      payload({ recipient: { invitationId: 'not-a-uuid' } }),
      payload({ organizationId: 'org_1' }),
      payload({ requestId: 'x'.repeat(250) }),
      payload({ refs: { 'a:b': 'v' } })

    ];
    for (const b of bad) await expect(producer.enqueue(b as EmailJobPayload)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(add).not.toHaveBeenCalled();
  });
  it('accepts userId recipients with id refs', () => {
    expect(() => validateEmailJobPayload(payload({ templateId: 'task-assigned', recipient: { userId: USR }, refs: { taskId: 'tsk_1' }, locale: 'en-US' }))).not.toThrow();
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
    await expect(createEmailProcessor(svc, resolver())({ id: '1', attemptsMade: 0, data: payload({ templateId: 'verification', recipient: { userId: USR } }) })).rejects.toBeInstanceOf(UnrecoverableError);
    const wrong: EmailJobResolver = { resolve: async () => ({ templateId: 'verification', to: 'a@x.test', variables: { name: 'a', verificationUrl: 'https://a.test', expiresInHours: 1 } }) };
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
    const r: EmailJobResolver = { resolve: async () => ({ templateId: 'invitation', to: 'a@x.test', variables: { inviterName: 'B', workspaceName: 'W', inviteUrl: 'javascript:alert(1)' } }) };
    await expect(createEmailProcessor(new ConsoleEmailService(), r)({ id: '1', attemptsMade: 0, data: payload() })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
