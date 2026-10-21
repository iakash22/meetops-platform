import { describe, it, expect, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { createEmailProducer, createEmailProcessor, DEFAULT_EMAIL_JOB_OPTIONS, ConsoleEmailService, type EmailService } from '../src';

describe('email producer', () => {
  it('enqueues template jobs with retry/backoff defaults', async () => {
    const add = vi.fn().mockResolvedValue({ id: '42' });
    const producer = createEmailProducer({ add, close: vi.fn() });
    const id = await producer.sendTemplate('invitation', 'a@x.test', { inviterName: 'B', workspaceName: 'W', inviteUrl: 'https://a.test' });
    expect(id).toBe('42');
    expect(add).toHaveBeenCalledWith('invitation', expect.objectContaining({ kind: 'template', template: 'invitation' }), expect.objectContaining({ attempts: 5, backoff: { type: 'exponential', delay: 2000 } }));
    expect(DEFAULT_EMAIL_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });
  it('allows overriding job options', async () => {
    const add = vi.fn().mockResolvedValue({ id: '1' });
    await createEmailProducer({ add, close: vi.fn() }).enqueue({ kind: 'raw', message: { to: 'a@x.test', subject: 's', text: 't' } }, { attempts: 2 });
    expect(add.mock.calls[0]?.[2]).toMatchObject({ attempts: 2 });
  });
});

describe('email processor', () => {
  it('renders and sends templated jobs', async () => {
    const svc = new ConsoleEmailService();
    const res = await createEmailProcessor(svc)({ id: '1', attemptsMade: 0, data: { kind: 'template', template: 'verification', to: 'a@x.test', variables: { name: 'A', verificationUrl: 'https://a.test', expiresInHours: 1 } } });
    expect(res.accepted).toEqual(['a@x.test']);
    expect(svc.sent[0]?.subject).toMatch(/Verify/);
  });
  it('rethrows transient errors so BullMQ retries', async () => {
    const svc: EmailService = { provider: 'mock', send: vi.fn().mockRejectedValue(new Error('ECONNRESET')), verify: vi.fn() };
    await expect(createEmailProcessor(svc)({ id: '1', attemptsMade: 0, data: { kind: 'raw', message: { to: 'a@x.test', subject: 's', text: 't' } } })).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
  it('marks bad payloads unrecoverable', async () => {
    const svc = new ConsoleEmailService();
    await expect(createEmailProcessor(svc)({ id: '1', attemptsMade: 0, data: { kind: 'template', template: 'password-reset', to: 'a@x.test', variables: { name: 'a', resetUrl: 'ftp://x', expiresInMinutes: 5 } } })).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(createEmailProcessor(svc)({ id: '2', attemptsMade: 0, data: { kind: 'raw', message: { to: 'a@x.test', subject: '', text: 't' } } })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
