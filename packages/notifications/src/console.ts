import { assertValidMessage } from './smtp.js';
import { recipientEmail, toArray, type EmailMessage, type EmailService, type SendResult } from './types.js';

/**
 * In-memory email adapter for tests and local development only.
 * Does not print bodies (they may contain tokens); stores messages in `sent`.
 */
export class ConsoleEmailService implements EmailService {
  readonly provider = 'console';
  readonly sent: EmailMessage[] = [];
  private counter = 0;

  constructor(private readonly options: { from?: string; log?: (line: string) => void } = {}) {}

  async send(message: EmailMessage): Promise<SendResult> {
    assertValidMessage(message);
    const stored = { ...message };
    if (!stored.from && this.options.from) stored.from = this.options.from;
    this.sent.push(stored);
    this.counter += 1;
    const to = toArray(message.to).map(recipientEmail);
    this.options.log?.(`[console-email] to=${to.join(',')} subject=${message.subject}`);
    return { messageId: `console-${this.counter}`, accepted: to, rejected: [], provider: this.provider };
  }

  async verify(): Promise<boolean> {
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
