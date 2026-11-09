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
  | { kind: 'password_changed'; userId: string; changedAt: string }
  /** Security notice after a sign-in provider was linked (OIDC review M-2); linkedAt is ISO 8601. */
  | {
      kind: 'account_linked';
      userId: string;
      provider: 'google';
      linkedAt: string;
      /** N-1 takeover: the unverified account's password was removed when Google proved the address. */
      passwordRemoved?: boolean;
    };

export interface AuthMailQueue {
  enqueue(job: AuthMailJob): Promise<void>;
}

export type AuthMailTemplate =
  | 'email_verification'
  | 'password_reset'
  | 'account_exists'
  | 'invitation'
  | 'login_lockout'
  | 'password_changed'
  | 'account_linked';

export interface OutboundMail {
  to: string;
  template: AuthMailTemplate;
  data: Record<string, string>;
}

/** Delivery port (adapter over @meetops/notifications createAuthMailTransport). Must never log data.url. */
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
