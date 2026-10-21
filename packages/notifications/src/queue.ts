import { UnrecoverableError, type Job, type JobsOptions, type Queue } from 'bullmq';
import { createQueue, createWorker } from '@meetops/queue';
import { logger as baseLogger } from '@meetops/logger';
import { renderTemplate, templateNames, type TemplateName, type TemplateVariables } from './templates.js';
import type { EmailRecipient, EmailService, SendResult } from './types.js';
import { EmailValidationError } from './smtp.js';

/**
 * Mirrors QUEUE_NAMES.email from @meetops/contracts (PR #17).
 * TODO: import { QUEUE_NAMES } from '@meetops/contracts' once #17 is on main.
 */
export const EMAIL_QUEUE_NAME = 'email';
export const EMAIL_JOB_NAME = 'send_email';

/** Short retention: payloads are ids-only, but keep Redis footprint and exposure small. */
export const DEFAULT_EMAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100, age: 3600 },
  removeOnFail: { count: 500, age: 24 * 3600 }
} satisfies JobsOptions;

/** Opaque id: letters, digits, '_' and '-'. Structurally excludes emails ('@'), URLs (':', '/'), and BullMQ-reserved ':'. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type EmailRecipientRef = { userId: string } | { invitationId: string };

/**
 * Ids-only email job (matches the JobMeta shape of @meetops/contracts: jobVersion, organizationId,
 * requestId?, idempotencyKey; kind 'send_email'; templateId). It deliberately carries NO email addresses,
 * names, tokens, links or free-form variables. The worker resolves those from the DB via EmailJobResolver.
 */
export interface EmailJobPayload {
  jobVersion: 1;
  organizationId: string;
  requestId?: string;
  /** Used as BullMQ jobId for dedupe. Must match SAFE_ID. */
  idempotencyKey: string;
  kind: 'send_email';
  templateId: TemplateName;
  recipient: EmailRecipientRef;
  /** Related entity ids (e.g. taskId, meetingId, resetRequestId). Values must match SAFE_ID. */
  refs?: Record<string, string>;
  locale?: string;
}

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

export function validateEmailJobPayload(p: unknown): asserts p is EmailJobPayload {
  const fail = (m: string): never => {
    throw new InvalidEmailJobError(`Invalid email job: ${m}`);
  };
  if (!p || typeof p !== 'object') fail('not an object');
  const j = p as Record<string, unknown>;
  const allowed = new Set(['jobVersion', 'organizationId', 'requestId', 'idempotencyKey', 'kind', 'templateId', 'recipient', 'refs', 'locale']);
  for (const k of Object.keys(j)) if (!allowed.has(k)) fail(`unexpected field ${k}`);
  if (j.jobVersion !== 1) fail('jobVersion must be 1');
  if (j.kind !== 'send_email') fail('kind must be send_email');
  for (const k of ['organizationId', 'idempotencyKey'] as const) {
    if (typeof j[k] !== 'string' || !SAFE_ID.test(j[k])) fail(`${k} must be an opaque id`);
  }
  if (j.requestId !== undefined && (typeof j.requestId !== 'string' || !SAFE_ID.test(j.requestId))) fail('requestId must be an opaque id');
  if (typeof j.templateId !== 'string' || !(templateNames as string[]).includes(j.templateId)) fail('unknown templateId');
  const r = j.recipient as Record<string, unknown> | undefined;
  const rKeys = r && typeof r === 'object' ? Object.keys(r) : [];
  const rKey = rKeys[0];
  if (rKeys.length !== 1 || (rKey !== 'userId' && rKey !== 'invitationId') || typeof r?.[rKey] !== 'string' || !SAFE_ID.test(r[rKey])) {
    fail('recipient must be exactly { userId } or { invitationId }');
  }
  if (j.refs !== undefined) {
    if (!j.refs || typeof j.refs !== 'object' || Array.isArray(j.refs)) fail('refs must be an object');
    for (const [k, v] of Object.entries(j.refs as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k) || typeof v !== 'string' || !SAFE_ID.test(v)) fail(`refs.${k} must be an opaque id`);
    }
  }
  if (j.locale !== undefined && (typeof j.locale !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(j.locale))) fail('invalid locale');
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
      return await service.send({ to: resolved.to, ...rendered, headers: { 'X-MeetOps-Idempotency-Key': job.data.idempotencyKey } });
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
