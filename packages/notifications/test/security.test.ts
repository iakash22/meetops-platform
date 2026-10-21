import { describe, it, expect, vi } from 'vitest';
import { SmtpEmailService, createEmailService, renderTemplate, sanitizeHeaderValue, type SmtpTransportFactory } from '../src';

describe('header injection', () => {
  it('strips CR/LF from subjects, names and headers', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'm', accepted: [], rejected: [] });
    const factory = (() => ({ sendMail, verify: vi.fn(), close: vi.fn() })) as unknown as SmtpTransportFactory;
    const svc = new SmtpEmailService({ provider: 'smtp', host: 'h', port: 465, secure: true, from: 'f@x.test' }, factory);
    await svc.send({ to: { email: 'a@x.test', name: 'A\r\nBcc: evil@x.test' }, subject: 'Hi\r\nBcc: evil@x.test', text: 't', headers: { 'X-A': 'v\nX-B: y' } });
    const mail = sendMail.mock.calls[0]?.[0] as { subject: string; to: string[]; headers: Record<string, string> };
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.to[0]).not.toMatch(/[\r\n]/);
    expect(mail.headers['X-A']).not.toMatch(/[\r\n]/);
    expect(sanitizeHeaderValue('a\r\nb')).toBe('a b');
  });
  it('template subjects never contain CR/LF', () => {
    const r = renderTemplate('task-assigned', { assigneeName: 'x', taskTitle: 'T\r\nBcc: evil@x.test', taskUrl: 'https://a.test' });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});

describe('console provider in production', () => {
  it('factory refuses console provider when NODE_ENV=production', () => {
    expect(() => createEmailService({ provider: 'console', from: 'x@y.z' }, { nodeEnv: 'production' })).toThrow(/not allowed in production/);
    expect(createEmailService({ provider: 'console', from: 'x@y.z' }, { nodeEnv: 'test' }).provider).toBe('console');
  });
});
