import { escapeHtml, renderTemplate, safeUrl, type RenderedEmail } from './templates.js';
import type { EmailService } from './types.js';

/**
 * Structural mirror of the api's `OutboundMail` (apps/api auth/domain/mail-jobs.ts). Declared here so the api can use
 * this adapter without notifications depending on the api. `data.url` carries a one-time token: never log it.
 */
export type AuthMailTemplateId =
  'email_verification' | 'password_reset' | 'account_exists' | 'invitation' | 'login_lockout';

export interface AuthOutboundMail {
  to: string;
  template: AuthMailTemplateId;
  data: Record<string, string>;
}

export interface AuthMailTransportOptions {
  /** Shown in the verification mail; must match the api's emailVerificationTtlMs. Default 24. */
  verificationExpiresInHours?: number;
  /** Shown in the reset mail; must match the api's passwordResetTtlMs. Default 30. */
  passwordResetExpiresInMinutes?: number;
}

export class UnknownAuthMailTemplateError extends Error {
  constructor(template: string) {
    super(`Unknown auth mail template: ${template}`);
    this.name = 'UnknownAuthMailTemplateError';
  }
}

function required(data: Record<string, string>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Auth mail is missing data.${key}`);
  return v;
}

function simple(subject: string, intro: string, url: string, label: string): RenderedEmail {
  const safe = safeUrl(url);
  return {
    subject,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(safe)}">${escapeHtml(label)}</a></p><p style="color:#666;font-size:12px">— MeetOps</p></body></html>`,
    text: `${intro}\n\n${label}: ${safe}`,
  };
}

/** Renders one auth mail. Exported for tests and previews. */
export function renderAuthMail(
  mail: AuthOutboundMail,
  options: AuthMailTransportOptions = {},
): RenderedEmail {
  const url = required(mail.data, 'url');
  switch (mail.template) {
    case 'email_verification':
      return renderTemplate('verification', {
        name: 'there',
        verificationUrl: url,
        expiresInHours: options.verificationExpiresInHours ?? 24,
      });
    case 'password_reset':
      return renderTemplate('password-reset', {
        name: 'there',
        resetUrl: url,
        expiresInMinutes: options.passwordResetExpiresInMinutes ?? 30,
      });
    case 'invitation':
      return renderTemplate('invitation', {
        inviterName: 'A teammate',
        workspaceName: required(mail.data, 'organizationName'),
        inviteUrl: url,
      });
    case 'account_exists':
      return simple(
        'You already have a MeetOps account',
        'Someone tried to sign up with this email address, but it already has an account. If that was you, sign in or reset your password.',
        url,
        'Reset password',
      );
    case 'login_lockout':
      return simple(
        'Sign-in temporarily locked',
        'We locked sign-in to your account for a short time after several failed attempts. If that was not you, reset your password.',
        url,
        'Reset password',
      );
    default:
      throw new UnknownAuthMailTemplateError(String((mail as { template: unknown }).template));
  }
}

/** Adapter from the api's MailTransport port to an EmailService (SMTP or console). */
export function createAuthMailTransport(
  service: EmailService,
  options: AuthMailTransportOptions = {},
) {
  return {
    async send(mail: AuthOutboundMail): Promise<void> {
      const rendered = renderAuthMail(mail, options);
      await service.send({ to: mail.to, ...rendered });
    },
  };
}
