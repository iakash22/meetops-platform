import { escapeHtml, renderTemplate, safeUrl, type RenderedEmail } from './templates.js';
import type { EmailService } from './types.js';

/**
 * Structural mirror of the api's `OutboundMail` (apps/api auth/domain/mail-jobs.ts). Declared here so the api can use
 * this adapter without notifications depending on the api. `data.url` carries a one-time token: never log it.
 */
export type AuthMailTemplateId =
  | 'email_verification'
  | 'password_reset'
  | 'account_exists'
  | 'invitation'
  | 'login_lockout'
  | 'password_changed';

/**
 * `data` keys per template (all strings; `url` always required):
 * - every template: `url`, optional `name` (recipient display name; falls back to "there")
 * - invitation: `organizationName`, optional `inviterName`, `role`, `expiresInDays`
 * - login_lockout: optional `lockedForMinutes`
 * - password_changed: `changedAt` (ISO 8601), optional `timeZone` (IANA, default UTC); `url` = reset link
 */

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

function optional(data: Record<string, string>, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function positiveInt(data: Record<string, string>, key: string): number | undefined {
  const v = optional(data, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Formats an ISO instant in the recipient's IANA time zone; unknown zones fall back to UTC. */
export function formatChangedAt(iso: string, timeZone = 'UTC'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    throw new Error('Auth mail data.changedAt must be an ISO date-time');
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
    }).format(d);
  try {
    return fmt(timeZone);
  } catch {
    return fmt('UTC');
  }
}

function simple(
  subject: string,
  name: string | undefined,
  intro: string,
  url: string,
  label: string,
): RenderedEmail {
  const safe = safeUrl(url);
  const hi = `Hi ${name ?? 'there'},`;
  return {
    subject,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><p>${escapeHtml(hi)}</p><p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(safe)}">${escapeHtml(label)}</a></p><p style="color:#666;font-size:12px">— MeetOps</p></body></html>`,
    text: `${hi}\n\n${intro}\n\n${label}: ${safe}`,
  };
}

/** Renders one auth mail. Exported for tests and previews. */
export function renderAuthMail(
  mail: AuthOutboundMail,
  options: AuthMailTransportOptions = {},
): RenderedEmail {
  const url = required(mail.data, 'url');
  const name = optional(mail.data, 'name');
  switch (mail.template) {
    case 'email_verification':
      return renderTemplate('verification', {
        name: name ?? 'there',
        verificationUrl: url,
        expiresInHours: options.verificationExpiresInHours ?? 24,
      });
    case 'password_reset':
      return renderTemplate('password-reset', {
        name: name ?? 'there',
        resetUrl: url,
        expiresInMinutes: options.passwordResetExpiresInMinutes ?? 30,
      });
    case 'invitation':
      return renderTemplate('invitation', {
        ...(name ? { name } : {}),
        inviterName: optional(mail.data, 'inviterName') ?? 'A teammate',
        workspaceName: required(mail.data, 'organizationName'),
        inviteUrl: url,
        ...(optional(mail.data, 'role') ? { role: optional(mail.data, 'role') } : {}),
        ...(positiveInt(mail.data, 'expiresInDays')
          ? { expiresInDays: positiveInt(mail.data, 'expiresInDays') }
          : {}),
      });
    case 'account_exists':
      return simple(
        'You already have a MeetOps account',
        name,
        'Someone tried to sign up with this email address, but it already has an account. If that was you, sign in or reset your password.',
        url,
        'Reset password',
      );
    case 'login_lockout': {
      const minutes = positiveInt(mail.data, 'lockedForMinutes');
      const span = minutes
        ? `for ${minutes} minute${minutes === 1 ? '' : 's'}`
        : 'for a short time';
      return simple(
        'Sign-in temporarily locked',
        name,
        `We locked sign-in to your account ${span} after several failed attempts. If that was not you, reset your password.`,
        url,
        'Reset password',
      );
    }
    case 'password_changed': {
      const when = formatChangedAt(
        required(mail.data, 'changedAt'),
        optional(mail.data, 'timeZone'),
      );
      return simple(
        'Your MeetOps password was changed',
        name,
        `Your password was changed on ${when}. If you did not make this change, reset your password now.`,
        url,
        'Reset password',
      );
    }
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
