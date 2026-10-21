export interface EmailAddress {
  email: string;
  name?: string;
}

export type EmailRecipient = string | EmailAddress;

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
  return r.name ? `"${r.name.replace(/"/g, '')}" <${r.email}>` : r.email;
}

export function recipientEmail(r: EmailRecipient): string {
  return typeof r === 'string' ? r : r.email;
}

export function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
