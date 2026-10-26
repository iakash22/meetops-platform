/**
 * Auth mail jobs carry ids only (D7). The worker (AuthMailJobHandler) resolves recipients,
 * mints tokens and builds links, so queue payloads never contain emails, tokens or URLs.
 */
export type AuthMailJob =
  /** tokenId null = unknown email (timing parity); the worker drops it. */
  | { kind: 'password_reset'; tokenId: string | null }
  | { kind: 'email_verification'; tokenId: string }
  | { kind: 'account_exists'; userId: string }
  /** userId null = unknown email (timing parity); the worker drops it. */
  | { kind: 'login_lockout'; userId: string | null }
  | { kind: 'invitation'; organizationId: string; invitationId: string }
  /** Security notice after a password change; changedAt is ISO 8601. */
  | { kind: 'password_changed'; userId: string; changedAt: string };

export interface AuthMailQueue {
  enqueue(job: AuthMailJob): Promise<void>;
}

export type AuthMailTemplate =
  | 'email_verification'
  | 'password_reset'
  | 'account_exists'
  | 'invitation'
  | 'login_lockout'
  | 'password_changed';

export interface OutboundMail {
  to: string;
  template: AuthMailTemplate;
  data: Record<string, string>;
}

/** Delivery port. TODO(notifications #11): adapter over sendTemplate. Must never log data.url. */
export interface MailTransport {
  send(mail: OutboundMail): Promise<void>;
}

/** Test double. */
export class RecordingMailTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];
  async send(mail: OutboundMail) {
    this.sent.push(mail);
  }
  /** Token from the last link sent to `to` for `template`. */
  lastToken(to: string, template: AuthMailTemplate): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to && x.template === template);
    return m?.data.url ? (new URL(m.data.url).searchParams.get('token') ?? undefined) : undefined;
  }
}
