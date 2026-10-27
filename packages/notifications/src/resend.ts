import type { ResendEmailConfig } from './config.js';
import { assertValidMessage, sanitizeHeaderValue } from './smtp.js';
import {
  formatRecipient,
  recipientEmail,
  toArray,
  type EmailMessage,
  type EmailService,
  type SendResult,
} from './types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DEFAULT_API_URL = 'https://api.resend.com';
const TIMEOUT_MS = 15_000;

/**
 * Resend API failure. The message carries the HTTP status and Resend's error `name` only, never the API key or
 * the request body (which contains one-time links). 429 and 5xx are retryable; other 4xx are permanent.
 */
export class ResendSendError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Resend API request failed (status ${status}${code ? `, ${code}` : ''})`);
    this.name = 'ResendSendError';
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

/** Email over the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). No SDK dependency. */
export class ResendEmailService implements EmailService {
  readonly provider = 'resend';
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ResendEmailConfig,
    fetchFn?: FetchLike,
  ) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'meetops-notifications',
    };
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertValidMessage(message);
    const to = toArray(message.to);
    const body: Record<string, unknown> = {
      from: message.from ? formatRecipient(message.from) : this.config.from,
      to: to.map(formatRecipient),
      subject: sanitizeHeaderValue(message.subject),
    };
    if (message.cc?.length) body.cc = message.cc.map(formatRecipient);
    if (message.bcc?.length) body.bcc = message.bcc.map(formatRecipient);
    if (message.replyTo) body.reply_to = formatRecipient(message.replyTo);
    if (message.html) body.html = message.html;
    if (message.text) body.text = message.text;
    if (message.attachments?.length) {
      // Inline images: `content_id` makes them resolvable from `cid:` references in the HTML.
      body.attachments = message.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType,
        content_id: a.cid,
      }));
    }
    if (message.headers) {
      body.headers = Object.fromEntries(
        Object.entries(message.headers).map(([k, v]) => [
          sanitizeHeaderValue(k),
          sanitizeHeaderValue(v),
        ]),
      );
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ResendSendError(0, 'network_error');
    }
    const json = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (!res.ok) {
      const code =
        typeof json.name === 'string' ? json.name.replace(/[^\w.-]/g, '').slice(0, 64) : '';
      throw new ResendSendError(res.status, code);
    }
    const accepted = to.map(recipientEmail);
    return {
      messageId: typeof json.id === 'string' ? json.id : '',
      accepted,
      rejected: [],
      provider: this.provider,
    };
  }

  /** Checks the key against the API (GET /domains). False on any failure; never throws. */
  async verify(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/domains`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
