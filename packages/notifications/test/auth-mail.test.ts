import { describe, expect, it } from 'vitest';
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
