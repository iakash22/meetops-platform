import { describe, it, expect, vi } from 'vitest';
import {
  createEmailService,
  loadEmailConfig,
  redactEmailConfig,
  ResendEmailService,
  ResendSendError,
  EmailConfigError,
  type FetchLike,
  type ResendEmailConfig,
} from '../src';

const KEY = 're_test_key_do_not_log';
const env = {
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: KEY,
  EMAIL_FROM: 'MeetOps <no-reply@example.test>',
};

function mockFetch(status: number, json: unknown) {
  return vi.fn<FetchLike>(async () => ({ ok: status < 300, status, json: async () => json }));
}

describe('resend config', () => {
  it('requires RESEND_API_KEY and EMAIL_FROM without echoing values', () => {
    expect(() => loadEmailConfig({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.test' })).toThrow(
      EmailConfigError,
    );
    expect(() => loadEmailConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY })).toThrow(
      /EMAIL_FROM/,
    );
    try {
      loadEmailConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });
  it('redacts the api key', () => {
    const red = JSON.stringify(redactEmailConfig(loadEmailConfig(env)));
    expect(red).not.toContain(KEY);
    expect(red).toContain('redacted');
  });
  it('factory builds a ResendEmailService', () => {
    expect(createEmailService(loadEmailConfig(env), { fetch: mockFetch(200, {}) })).toBeInstanceOf(
      ResendEmailService,
    );
  });
});

describe('ResendEmailService', () => {
  const cfg = loadEmailConfig(env) as ResendEmailConfig;

  it('POSTs /emails with bearer auth, inline attachments and returns the id', async () => {
    const f = mockFetch(200, { id: 'msg_1' });
    const svc = new ResendEmailService(cfg, f);
    const r = await svc.send({
      to: { email: 'u@example.test', name: 'U' },
      subject: 'Hi',
      html: '<img src="cid:logo">',
      text: 'hi',
      attachments: [
        {
          filename: 'logo.png',
          cid: 'logo',
          contentType: 'image/png',
          content: 'AAAA',
          encoding: 'base64',
        },
      ],
    });
    expect(r).toMatchObject({
      messageId: 'msg_1',
      accepted: ['u@example.test'],
      provider: 'resend',
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'MeetOps <no-reply@example.test>',
      to: ['"U" <u@example.test>'],
      subject: 'Hi',
      attachments: [{ filename: 'logo.png', content_id: 'logo', content_type: 'image/png' }],
    });
  });

  it.each([
    [422, false],
    [401, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    'status %i -> ResendSendError retryable=%s, no key or body in message',
    async (status, retryable) => {
      const svc = new ResendEmailService(
        cfg,
        mockFetch(status, { name: 'validation_error', message: 'secret body' }),
      );
      const err = await svc
        .send({ to: 'u@example.test', subject: 's', text: 'https://x/verify?token=abc' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ResendSendError);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain('token=abc');
      expect(err.message).not.toContain('secret body');
    },
  );

  it('network failure is retryable and opaque', async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error(`connect failed ${KEY}`);
    });
    const err = await new ResendEmailService(cfg, f)
      .send({ to: 'u@example.test', subject: 's', text: 't' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ResendSendError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(KEY);
  });

  it('verify returns false instead of throwing', async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error('down');
    });
    await expect(new ResendEmailService(cfg, f).verify()).resolves.toBe(false);
  });
});
