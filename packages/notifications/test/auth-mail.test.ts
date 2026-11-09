import { describe, expect, it, vi } from 'vitest';
import { SmtpEmailService, type SmtpTransportFactory } from '../src/smtp.js';
import {
  createAuthMailTransport,
  renderAuthMail,
  type AuthMailTemplateId,
} from '../src/auth-mail.js';
import type { EmailMessage, EmailService } from '../src/types.js';

function recorder() {
  const sent: EmailMessage[] = [];
  const service: EmailService = {
    provider: 'test',
    async send(m) {
      sent.push(m);
      return { messageId: '1', accepted: [], rejected: [], provider: 'test' };
    },
    async verify() {
      return true;
    },
  };
  return { sent, service };
}

const url = 'https://app.example.com/reset-password?token=abc';

describe('createAuthMailTransport', () => {
  it.each<AuthMailTemplateId>([
    'email_verification',
    'password_reset',
    'account_exists',
    'login_lockout',
  ])('renders %s with the link', async (template) => {
    const { sent, service } = recorder();
    await createAuthMailTransport(service).send({ to: 'a@example.com', template, data: { url } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('a@example.com');
    expect(sent[0]?.text).toContain(url);
    expect(sent[0]?.subject.length).toBeGreaterThan(0);
  });

  it('renders invitations with an escaped organization name', () => {
    const r = renderAuthMail({
      to: 'a@example.com',
      template: 'invitation',
      data: { url, organizationName: '<b>Acme</b>' },
    });
    expect(r.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(r.html).not.toContain('<b>Acme</b>');
  });

  it('refuses non-http links and missing data', () => {
    expect(() =>
      renderAuthMail({
        to: 'a@example.com',
        template: 'account_exists',
        data: { url: 'javascript:alert(1)' },
      }),
    ).toThrow();
    expect(() =>
      renderAuthMail({ to: 'a@example.com', template: 'invitation', data: { url } }),
    ).toThrow(/organizationName/);
  });

  it('renders the account-linked notice with the provider and time, and requires both', () => {
    const r = renderAuthMail({
      to: 'a@example.com',
      template: 'account_linked',
      data: { url, provider: 'Google', linkedAt: '2026-11-09T15:00:00.000Z', timeZone: 'UTC' },
    });
    expect(r.subject).toBe('Google sign-in was added to your MeetOps account');
    expect(r.text).toContain('Nov 9, 2026');
    expect(r.text).toContain(url);
    expect(() =>
      renderAuthMail({ to: 'a@example.com', template: 'account_linked', data: { url } }),
    ).toThrow(/provider/);
  });

  it('rejects unknown templates', () => {
    expect(() =>
      renderAuthMail({
        to: 'a@example.com',
        template: 'nope' as AuthMailTemplateId,
        data: { url },
      }),
    ).toThrow(/Unknown auth mail template/);
  });
});

describe('attachments reach the transport', () => {
  it.each<AuthMailTemplateId>([
    'email_verification',
    'password_reset',
    'account_exists',
    'login_lockout',
    'invitation',
  ])('%s: every cid in the html is sent as an attachment, themed layout used', async (template) => {
    const { sent, service } = recorder();
    await createAuthMailTransport(service).send({
      to: 'a@example.com',
      template,
      data: { url, organizationName: 'Acme' },
    });
    const msg = sent[0]!;
    const cids = [...new Set([...(msg.html ?? '').matchAll(/cid:([^"')\s]+)/g)].map((m) => m[1]))];
    expect(cids.sort()).toEqual(['meetops-banner@meetops', 'meetops-logo@meetops']);
    expect(msg.attachments?.map((a) => a.cid).sort()).toEqual(cids);
    for (const a of msg.attachments ?? []) {
      expect(a.encoding).toBe('base64');
      expect(a.content.length).toBeGreaterThan(100);
      expect(a.contentType).toMatch(/^image\/(png|gif)$/);
    }
    expect(msg.html).toContain('<h1');
  });
});

describe('auth mail -> SMTP attachments', () => {
  it('forwards the logo and banner CID attachments to nodemailer inline', async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ messageId: '<id@test>', accepted: ['a@x.test'], rejected: [] });
    const factory = vi.fn(() => ({
      sendMail,
      verify: vi.fn(),
      close: vi.fn(),
    })) as unknown as SmtpTransportFactory;
    const svc = new SmtpEmailService(
      { provider: 'smtp', host: 'h', port: 465, secure: true, from: 'MeetOps <n@x.test>' },
      factory,
    );
    await createAuthMailTransport(svc).send({
      to: 'a@x.test',
      template: 'login_lockout',
      data: { url: 'https://app.x.test/reset?t=1' },
    });
    const mail = sendMail.mock.calls[0]![0] as {
      html: string;
      attachments: { cid: string; contentDisposition: string; contentType: string }[];
    };
    expect(mail.attachments.map((a) => a.cid).sort()).toEqual([
      'meetops-banner@meetops',
      'meetops-logo@meetops',
    ]);
    expect(mail.attachments.every((a) => a.contentDisposition === 'inline')).toBe(true);
    expect(mail.attachments.map((a) => a.contentType).sort()).toEqual(['image/gif', 'image/png']);
    expect(mail.html).toContain('cid:meetops-banner@meetops');
  });
});
