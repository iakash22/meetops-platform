import { renderEmail } from './email/catalog.js';
import { renderTemplate, type RenderedEmail, type TemplateVariables } from './templates.js';
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
  | 'password_changed'
  | 'account_linked';

/**
 * `data` keys per template (all strings; `url` always required):
 * - every template: `url`, optional `name` (recipient display name; falls back to the generic greeting)
 * - invitation: `organizationName`, optional `inviterName`, `role`, `expiresInDays`
 * - login_lockout: optional `lockedForMinutes`
 * - password_changed: `changedAt` (ISO 8601), optional `timeZone` (IANA, default UTC); `url` = reset link
 * - account_linked: `provider` (display name, e.g. Google), `linkedAt` (ISO 8601), optional `timeZone`; `url` = reset
 *   link
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

/** Renders one auth mail. Exported for tests and previews. */
export function renderAuthMail(
  mail: AuthOutboundMail,
  options: AuthMailTransportOptions = {},
): RenderedEmail {
  const url = required(mail.data, 'url');
  const name = optional(mail.data, 'name');
  const named = name ? { name } : {};
  switch (mail.template) {
    case 'email_verification':
      return renderTemplate('verification', {
        ...named,
        verificationUrl: url,
        expiresInHours: options.verificationExpiresInHours ?? 24,
      });
    case 'password_reset':
      return renderTemplate('password-reset', {
        ...named,
        resetUrl: url,
        expiresInMinutes: options.passwordResetExpiresInMinutes ?? 30,
      });
    case 'invitation': {
      const vars: TemplateVariables['invitation'] = {
        inviterName: optional(mail.data, 'inviterName') ?? 'A teammate',
        workspaceName: required(mail.data, 'organizationName'),
        inviteUrl: url,
      };
      const role = optional(mail.data, 'role');
      const expiresInDays = positiveInt(mail.data, 'expiresInDays');
      if (role) vars.role = role;
      if (expiresInDays) vars.expiresInDays = expiresInDays;
      return renderTemplate('invitation', vars);
    }
    case 'account_exists':
      return renderEmail('account-exists', { ...named, resetUrl: url });
    case 'login_lockout': {
      const lockedForMinutes = positiveInt(mail.data, 'lockedForMinutes');
      return renderEmail('login-lockout', {
        ...named,
        resetUrl: url,
        ...(lockedForMinutes ? { lockedForMinutes } : {}),
      });
    }
    case 'password_changed':
      return renderEmail('password-changed', {
        ...named,
        resetUrl: url,
        changedAt: formatChangedAt(
          required(mail.data, 'changedAt'),
          optional(mail.data, 'timeZone'),
        ),
      });
    case 'account_linked':
      return renderEmail('account-linked', {
        ...named,
        provider: required(mail.data, 'provider'),
        resetUrl: url,
        linkedAt: formatChangedAt(required(mail.data, 'linkedAt'), optional(mail.data, 'timeZone')),
      });
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
      // Inline CID images (logo, banner GIF) must travel with the HTML that references them.
      await service.send({
        to: mail.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: rendered.attachments,
      });
    },
  };
}
