import { UnrecoverableError, type Job, type JobsOptions, type Queue } from 'bullmq';
import { createQueue, createWorker } from '@meetops/queue';
import { logger as baseLogger } from '@meetops/logger';
import { Value } from '@sinclair/typebox/value';
import {
  EMAIL_JOB_RETENTION,
  EMAIL_QUEUE,
  EmailJobPayload as EmailJobPayloadSchema,
  type EmailJobPayload
} from '@meetops/contracts';
import { renderTemplate, type TemplateName, type TemplateVariables } from './templates.js';
import type { EmailRecipient, EmailService, SendResult } from './types.js';
import { EmailValidationError } from './smtp.js';

export const EMAIL_QUEUE_NAME = EMAIL_QUEUE;
export const EMAIL_JOB_NAME = 'send_email';

/** Short, bounded retention from the contract; payloads are ids-only but keep Redis footprint/exposure small. */
export const DEFAULT_EMAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { ...EMAIL_JOB_RETENTION.removeOnComplete },
  removeOnFail: { ...EMAIL_JOB_RETENTION.removeOnFail }
} satisfies JobsOptions;

export type { EmailJobPayload };
export type EmailRecipientRef = EmailJobPayload['recipient'];

/** What the resolver returns: real recipient + fully built template variables (links incl. fresh tokens). */
export type ResolvedEmail<K extends TemplateName = TemplateName> = {
  [P in K]: { templateId: P; to: EmailRecipient; variables: TemplateVariables[P] };
}[K];

/**
 * Implemented by Backend (DB-backed). Looks up the user/invitation inside `organizationId`, checks it is still
 * valid, mints any one-time tokens and builds links. Return null when the recipient no longer exists or the
 * email should not be sent (job is then failed without retry).
 */
export interface EmailJobResolver {
  resolve(payload: EmailJobPayload): Promise<ResolvedEmail | null>;
}

export class InvalidEmailJobError extends UnrecoverableError {}
/** Non-retryable failure (bad payload/template); BullMQ fails the job without further attempts. */
export class PermanentEmailError extends UnrecoverableError {}

/**
 * Validates solely against the contracts EmailJobPayload schema (single source of truth; no local rules so shapes
 * cannot drift). Invalid jobs throw InvalidEmailJobError (UnrecoverableError) and are never retried.
 */
export function validateEmailJobPayload(p: unknown): asserts p is EmailJobPayload {
  if (!Value.Check(EmailJobPayloadSchema, p)) {
    const first = Value.Errors(EmailJobPayloadSchema, p).First();
    throw new InvalidEmailJobError(`Invalid email job: schema violation${first ? ` at ${first.path || '/'}` : ''}`);
  }
}

type QueueLike = Pick<Queue<EmailJobPayload>, 'add' | 'close'>;

export interface EmailProducer {
  /** Validates the ids-only payload and enqueues it with jobId = idempotencyKey (duplicates are ignored by BullMQ). */
  enqueue(payload: EmailJobPayload, opts?: Omit<JobsOptions, 'jobId'>): Promise<string | undefined>;
  close(): Promise<void>;
}

export function createEmailProducer(queue: QueueLike = createQueue<EmailJobPayload>(EMAIL_QUEUE_NAME)): EmailProducer {
  return {
    async enqueue(payload, opts) {
      validateEmailJobPayload(payload);
      const job = await queue.add(EMAIL_JOB_NAME, payload, {
        ...DEFAULT_EMAIL_JOB_OPTIONS,
        ...opts,
        jobId: payload.idempotencyKey
      });
      return job.id;
    },
    async close() {
      await queue.close();
    }
  };
}

export function createEmailProcessor(service: EmailService, resolver: EmailJobResolver) {
  return async (job: Pick<Job<EmailJobPayload>, 'id' | 'data' | 'attemptsMade'>): Promise<SendResult> => {
    validateEmailJobPayload(job.data);
    const resolved = await resolver.resolve(job.data); // DB errors are transient -> retried
    if (!resolved) throw new PermanentEmailError('Recipient could not be resolved');
    if (resolved.templateId !== job.data.templateId) throw new PermanentEmailError('Resolver returned a different template');
    let rendered;
    try {
      rendered = renderTemplate(resolved.templateId, resolved.variables as never);
    } catch (err) {
      throw new PermanentEmailError(`Failed to build email: ${(err as Error).message}`);
    }
    try {
      return await service.send({
        to: resolved.to,
        ...rendered,
        headers: { ...rendered.headers, 'X-MeetOps-Idempotency-Key': job.data.idempotencyKey },
      });
    } catch (err) {
      if (err instanceof EmailValidationError) throw new PermanentEmailError(err.message);
      throw err; // transient -> retried with exponential backoff
    }
  };
}

export function startEmailWorker(service: EmailService, resolver: EmailJobResolver, options: { concurrency?: number } = {}) {
  const log = baseLogger.child({ component: 'email-worker' });
  const processor = createEmailProcessor(service, resolver);
  const worker = createWorker<EmailJobPayload, SendResult>(EMAIL_QUEUE_NAME, (job) => processor(job), {
    concurrency: options.concurrency ?? 5
  });
  log.info({ queue: EMAIL_QUEUE_NAME, provider: service.provider }, 'email worker started');
  return worker;
}
