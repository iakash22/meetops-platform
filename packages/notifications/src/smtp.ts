import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { SmtpEmailConfig } from './config.js';
import {
  formatRecipient,
  toArray,
  type EmailMessage,
  type EmailService,
  type SendResult,
} from './types.js';

export type SmtpTransportFactory = (
  options: SMTPTransport.Options,
) => Pick<Transporter<SMTPTransport.SentMessageInfo>, 'sendMail' | 'verify' | 'close'>;

const defaultFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export class EmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailValidationError';
  }
}

/** Removes CR/LF (and other control chars) to prevent header injection. */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function assertValidMessage(message: EmailMessage): void {
  if (toArray(message.to).length === 0)
    throw new EmailValidationError('Email requires at least one recipient');
  if (!message.subject?.trim()) throw new EmailValidationError('Email requires a subject');
  if (!message.html && !message.text)
    throw new EmailValidationError('Email requires html or text body');
  for (const a of message.attachments ?? []) {
    // Inline images only: header-bearing fields must be plain tokens (no CR/LF injection into MIME headers).
    if (!/^[A-Za-z0-9._@-]{1,128}$/.test(a.cid))
      throw new EmailValidationError('Invalid attachment cid');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(a.filename))
      throw new EmailValidationError('Invalid attachment filename');
    if (!/^image\/(png|jpeg|gif|webp)$/.test(a.contentType))
      throw new EmailValidationError('Invalid attachment content type');
    if (a.encoding !== 'base64' || !/^[A-Za-z0-9+/]+={0,2}$/.test(a.content)) {
      throw new EmailValidationError('Attachment content must be base64');
    }
  }
}

export class SmtpEmailService implements EmailService {
  readonly provider = 'smtp';
  private readonly transport: ReturnType<SmtpTransportFactory>;

  constructor(
    private readonly config: SmtpEmailConfig,
    factory: SmtpTransportFactory = defaultFactory,
  ) {
    const options: SMTPTransport.Options = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Never enable nodemailer debug/logger: they can emit credentials.
      logger: false,
      debug: false,
    };
    if (config.auth) options.auth = { user: config.auth.user, pass: config.auth.pass };
    this.transport = factory(options);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertValidMessage(message);
    const mail: Record<string, unknown> = {
      from: message.from ? formatRecipient(message.from) : this.config.from,
      to: toArray(message.to).map(formatRecipient),
      subject: sanitizeHeaderValue(message.subject),
    };
    if (message.cc?.length) mail.cc = message.cc.map(formatRecipient);
    if (message.bcc?.length) mail.bcc = message.bcc.map(formatRecipient);
    if (message.replyTo) mail.replyTo = formatRecipient(message.replyTo);
    if (message.html) mail.html = message.html;
    if (message.text) mail.text = message.text;
    if (message.attachments?.length) {
      mail.attachments = message.attachments.map((a) => ({
        filename: a.filename,
        cid: a.cid,
        contentType: a.contentType,
        content: a.content,
        encoding: a.encoding,
        contentDisposition: 'inline',
      }));
    }
    if (message.headers) {
      mail.headers = Object.fromEntries(
        Object.entries(message.headers).map(([k, v]) => [
          sanitizeHeaderValue(k),
          sanitizeHeaderValue(v),
        ]),
      );
    }
    const info = await this.transport.sendMail(mail);
    return {
      messageId: info.messageId,
      accepted: ((info.accepted ?? []) as Array<string | { address: string }>).map((a) =>
        typeof a === 'string' ? a : a.address,
      ),
      rejected: ((info.rejected ?? []) as Array<string | { address: string }>).map((a) =>
        typeof a === 'string' ? a : a.address,
      ),
      provider: this.provider,
    };
  }

  async verify(): Promise<boolean> {
    try {
      return await this.transport.verify();
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}
