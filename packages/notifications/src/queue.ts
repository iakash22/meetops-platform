import { UnrecoverableError, type Job, type JobsOptions, type Queue } from 'bullmq';
import { createQueue, createWorker } from '@meetops/queue';
import { logger as baseLogger } from '@meetops/logger';
import { renderTemplate, type TemplateName, type TemplateVariables } from './templates.js';
import type { EmailMessage, EmailRecipient, EmailService, SendResult } from './types.js';
import { EmailValidationError } from './smtp.js';

export const EMAIL_QUEUE_NAME = 'notifications-email';

export const DEFAULT_EMAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 }
} satisfies JobsOptions;

export type TemplatedEmailJob = {
  [K in TemplateName]: {
    kind: 'template';
    template: K;
    variables: TemplateVariables[K];
    to: EmailRecipient | EmailRecipient[];
    cc?: EmailRecipient[];
    bcc?: EmailRecipient[];
    replyTo?: EmailRecipient;
  };
}[TemplateName];

export type RawEmailJob = { kind: 'raw'; message: EmailMessage };
export type EmailJobData = TemplatedEmailJob | RawEmailJob;

type QueueLike = Pick<Queue<EmailJobData>, 'add' | 'close'>;

export interface EmailProducer {
  enqueue(data: EmailJobData, opts?: JobsOptions): Promise<string | undefined>;
  sendTemplate<K extends TemplateName>(
    template: K,
    to: EmailRecipient | EmailRecipient[],
    variables: TemplateVariables[K],
    opts?: JobsOptions
  ): Promise<string | undefined>;
  close(): Promise<void>;
}

export function createEmailProducer(queue: QueueLike = createQueue<EmailJobData>(EMAIL_QUEUE_NAME)): EmailProducer {
  return {
    async enqueue(data, opts) {
      const name = data.kind === 'template' ? data.template : 'raw';
      const job = await queue.add(name, data, { ...DEFAULT_EMAIL_JOB_OPTIONS, ...opts });
      return job.id;
    },
    async sendTemplate(template, to, variables, opts) {
      return this.enqueue({ kind: 'template', template, to, variables } as TemplatedEmailJob, opts);
    },
    async close() {
      await queue.close();
    }
  };
}

export function buildMessage(data: EmailJobData): EmailMessage {
  if (data.kind === 'raw') return data.message;
  const rendered = renderTemplate(data.template, data.variables as never);
  const msg: EmailMessage = { to: data.to, ...rendered };
  if (data.cc) msg.cc = data.cc;
  if (data.bcc) msg.bcc = data.bcc;
  if (data.replyTo) msg.replyTo = data.replyTo;
  return msg;
}

/** Non-retryable failure (bad payload/template); BullMQ fails the job without further attempts. */
export class PermanentEmailError extends UnrecoverableError {}

export function createEmailProcessor(service: EmailService) {
  return async (job: Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade'>): Promise<SendResult> => {
    let message: EmailMessage;
    try {
      message = buildMessage(job.data);
    } catch (err) {
      throw new PermanentEmailError(`Failed to build email: ${(err as Error).message}`);
    }
    try {
      return await service.send(message);
    } catch (err) {
      if (err instanceof EmailValidationError) throw new PermanentEmailError(err.message);
      throw err; // transient -> retried with exponential backoff
    }
  };
}

export function startEmailWorker(service: EmailService, options: { concurrency?: number } = {}) {
  const log = baseLogger.child({ component: 'email-worker' });
  const processor = createEmailProcessor(service);
  const worker = createWorker<EmailJobData, SendResult>(EMAIL_QUEUE_NAME, (job) => processor(job), {
    concurrency: options.concurrency ?? 5
  });
  log.info({ queue: EMAIL_QUEUE_NAME, provider: service.provider }, 'email worker started');
  return worker;
}
