import { describe, it, expect, vi } from 'vitest';
import { SmtpEmailService, ConsoleEmailService, createEmailService, EmailValidationError, type SmtpTransportFactory } from '../src';

function mockFactory() {
  const sendMail = vi.fn().mockResolvedValue({ messageId: '<id@test>', accepted: ['a@x.test'], rejected: [] });
  const verify = vi.fn().mockResolvedValue(true);
  const close = vi.fn();
  const factory = vi.fn(() => ({ sendMail, verify, close })) as unknown as SmtpTransportFactory;
  return { factory, sendMail, verify, close };
}

const cfg = { provider: 'smtp' as const, host: 'h', port: 465, secure: true, from: 'MeetOps <n@x.test>', auth: { user: 'u', pass: 'p' } };

describe('SmtpEmailService', () => {
  it('builds transport from config with logging disabled', () => {
    const m = mockFactory();
    new SmtpEmailService(cfg, m.factory);
    expect(m.factory).toHaveBeenCalledWith(expect.objectContaining({ host: 'h', port: 465, secure: true, logger: false, debug: false, auth: { user: 'u', pass: 'p' } }));
  });
  it('sends with default from and formats recipients', async () => {
    const m = mockFactory();
    const svc = new SmtpEmailService(cfg, m.factory);
    const res = await svc.send({ to: [{ email: 'a@x.test', name: 'A' }, 'b@x.test'], subject: 'Hi', text: 'body' });
    expect(m.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: cfg.from, to: ['"A" <a@x.test>', 'b@x.test'], subject: 'Hi', text: 'body' }));
    expect(res).toEqual({ messageId: '<id@test>', accepted: ['a@x.test'], rejected: [], provider: 'smtp' });
  });
  it('validates messages', async () => {
    const svc = new SmtpEmailService(cfg, mockFactory().factory);
    await expect(svc.send({ to: [], subject: 's', text: 't' })).rejects.toBeInstanceOf(EmailValidationError);
    await expect(svc.send({ to: 'a@x.test', subject: 's' })).rejects.toBeInstanceOf(EmailValidationError);
  });
  it('verify returns false on transport error', async () => {
    const m = mockFactory();
    m.verify.mockRejectedValueOnce(new Error('auth failed'));
    expect(await new SmtpEmailService(cfg, m.factory).verify()).toBe(false);
  });
});

describe('ConsoleEmailService / factory', () => {
  it('records messages in memory', async () => {
    const svc = new ConsoleEmailService();
    const r = await svc.send({ to: 'a@x.test', subject: 's', text: 't' });
    expect(r.provider).toBe('console');
    expect(svc.sent).toHaveLength(1);
  });
  it('factory picks adapter by provider', () => {
    expect(createEmailService({ provider: 'console', from: 'x@y.z' }, { nodeEnv: 'test' }).provider).toBe('console');
    expect(createEmailService(cfg, { smtpTransportFactory: mockFactory().factory }).provider).toBe('smtp');
  });
});
