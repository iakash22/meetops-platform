import type { AuthMailTemplate, MailTransport, OutboundMail } from './mail-jobs.js';

/**
 * Compatibility test double for the repo-level QA harness (tests/support/api-app.ts), which
 * predates id-only mail jobs (D7) and expects `{ kind, to, token }` records. It is a
 * MailTransport, so it sees mail only after the worker-side handler rendered it.
 * Pass it as `mailTransport` (or the legacy `mailer` dep alias, tests only).
 */
const KIND: Record<AuthMailTemplate, string> = {
  email_verification: 'verify',
  password_reset: 'reset',
  account_exists: 'exists',
  invitation: 'invite',
  login_lockout: 'lockout',
  password_changed: 'password-changed'
};

export class RecordingAuthMailer implements MailTransport {
  readonly sent: { kind: string; to: string; token?: string }[] = [];
  async send(mail: OutboundMail) {
    const url = mail.data.url;
    const token = url ? (new URL(url).searchParams.get('token') ?? undefined) : undefined;
    this.sent.push({ kind: KIND[mail.template], to: mail.to, ...(token ? { token } : {}) });
  }
}
