import type { EmailAddress as ContractEmailAddress } from '@meetops/contracts';

/** `{ email, name? }` from @meetops/contracts. */
export type EmailAddress = ContractEmailAddress;

export type EmailRecipient = string | EmailAddress;

/**
 * Transport-level message. Intentionally NOT the contracts legacy `EmailMessage` (which requires `from` and an
 * array `to`, and lacks replyTo/headers). Ours lets `from` default to EMAIL_FROM.
 */
export interface EmailMessage {
  to: EmailRecipient | EmailRecipient[];
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
  /** Overrides EMAIL_FROM when provided. */
  from?: EmailRecipient;
  replyTo?: EmailRecipient;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  provider: string;
}

export interface EmailService {
  readonly provider: string;
  send(message: EmailMessage): Promise<SendResult>;
  /** Verify connectivity/credentials with the provider. */
  verify(): Promise<boolean>;
  close?(): Promise<void>;
}

export function formatRecipient(r: EmailRecipient): string {
  if (typeof r === 'string') return r;
  // eslint-disable-next-line no-control-regex
  const clean = (v: string) => v.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
  return r.name ? `"${clean(r.name).replace(/"/g, '')}" <${clean(r.email)}>` : clean(r.email);
}

export function recipientEmail(r: EmailRecipient): string {
  return typeof r === 'string' ? r : r.email;
}

export function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
