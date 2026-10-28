import { createHash } from 'node:crypto';
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from 'bullmq';
import type { AuthMailJob, AuthMailQueue } from '../../domain/mail-jobs.js';
import { safeMailError, type MailLog } from '../../application/auth-mail.handler.js';
import type { Clock } from '../../../../shared/ports.js';

/**
 * notifications #11 / ADR-013: production auth mail queue. The API enqueues ids-only AuthMailJobs on the
 * `auth-mail` BullMQ queue; a worker consumer (startAuthMailWorker) runs AuthMailJobHandler, which resolves
 * recipients, mints tokens and sends through the EmailService EMAIL_PROVIDER selects (smtp or resend).
 */
export const AUTH_MAIL_QUEUE = 'auth-mail';

/** User-keyed notices (account_exists, login_lockout) collapse to one mail per user per window. */
export const AUTH_MAIL_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

/** Retries with exponential backoff; bounded retention also bounds the idempotency window. */
export const AUTH_MAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} as const satisfies JobsOptions;

const JOB_ID_RE = /^authmail_[a-z_]{1,32}_[0-9a-f]{40}$/;

const hash = (parts: readonly string[]) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);

/**
 * Deterministic BullMQ job id (no ':' — BullMQ rejects it). Only the kind and a SHA-256 of non-PII ids (token row
 * id, user id, org + invitation id, time bucket) go in: never emails, names, tokens or URLs. Returns null for
 * timing-parity jobs with no subject (unknown email), which the handler would drop anyway.
 */
export function authMailJobId(job: AuthMailJob, now: Date): string | null {
  const bucket = String(Math.floor(now.getTime() / AUTH_MAIL_DEDUPE_WINDOW_MS));
  let parts: string[] | null;
  switch (job.kind) {
    case 'email_verification':
    case 'password_reset':
      parts = job.tokenId ? [job.tokenId] : null;
      break;
    case 'account_exists':
      parts = [job.userId, bucket];
      break;
    case 'login_lockout':
      parts = job.userId ? [job.userId, bucket] : null;
      break;
    case 'invitation':
      parts = [job.organizationId, job.invitationId];
      break;
    case 'password_changed':
      parts = [job.userId, job.changedAt];
      break;
    default:
      parts = null;
  }
  if (!parts) return null;
  const id = `authmail_${job.kind}_${hash([job.kind, ...parts])}`;
  assertNoPiiInJobId(id);
  return id;
}

/** Fails closed if a job id could carry PII: only the fixed `authmail_<kind>_<hex>` shape is accepted. */
export function assertNoPiiInJobId(id: string): void {
  if (!JOB_ID_RE.test(id) || id.includes('@'))
    throw new Error('auth mail job id has an unsafe shape');
}

/** Minimal producer surface (BullMQ Queue#add), injectable for tests. */
export interface AuthMailProducer {
  add(name: string, data: AuthMailJob, opts: JobsOptions): Promise<unknown>;
  close?(): Promise<void>;
}

/** Strips anything beyond the ids each kind needs (payload minimisation). */
export function minimalAuthMailPayload(job: AuthMailJob): AuthMailJob {
  switch (job.kind) {
    case 'email_verification':
      return { kind: job.kind, tokenId: job.tokenId };
    case 'password_reset':
      return { kind: job.kind, tokenId: job.tokenId };
    case 'account_exists':
      return { kind: job.kind, userId: job.userId };
    case 'login_lockout':
      return { kind: job.kind, userId: job.userId };
    case 'invitation':
      return { kind: job.kind, organizationId: job.organizationId, invitationId: job.invitationId };
    case 'password_changed':
      return { kind: job.kind, userId: job.userId, changedAt: job.changedAt };
  }
}

/**
 * Durable AuthMailQueue. Like the inline queue, enqueue never throws: a Redis outage must not turn signup or invites
 * into a 500. The error is logged by class/code only.
 */
export class BullMqAuthMailQueue implements AuthMailQueue {
  constructor(
    private readonly producer: AuthMailProducer,
    private readonly clock: Clock,
    public log: MailLog | null = null,
  ) {}

  async enqueue(job: AuthMailJob): Promise<void> {
    const jobId = authMailJobId(job, this.clock.now());
    if (!jobId) return;
    try {
      await this.producer.add(job.kind, minimalAuthMailPayload(job), {
        ...AUTH_MAIL_JOB_OPTIONS,
        jobId,
      });
    } catch (err) {
      this.log?.error(
        { kind: job.kind, jobId, err: safeMailError(err) },
        'auth mail enqueue failed',
      );
    }
  }

  async close(): Promise<void> {
    await this.producer.close?.();
  }
}

export interface AuthMailQueueConnection {
  redisUrl: string;
  /** BullMQ key prefix (AUTH_MAIL_QUEUE_PREFIX); default `bull`. */
  prefix?: string | undefined;
}

/** BullMQ producer, created lazily on the first enqueue so building deps opens no connection. */
export function createAuthMailProducer(
  conn: AuthMailQueueConnection,
  onError: (err: Error) => void = () => {},
): AuthMailProducer {
  let queue: Queue<AuthMailJob> | undefined;
  const get = () => {
    if (!queue) {
      queue = new Queue<AuthMailJob>(AUTH_MAIL_QUEUE, {
        connection: { url: conn.redisUrl, maxRetriesPerRequest: null },
        ...(conn.prefix ? { prefix: conn.prefix } : {}),
      });
      queue.on('error', onError);
    }
    return queue;
  };
  return {
    add: (name, data, opts) => get().add(name, data, opts),
    close: async () => {
      await queue?.close();
    },
  };
}

/**
 * Errors that will not succeed on retry, per provider (the job always stays on the provider EMAIL_PROVIDER selected;
 * there is no fallback):
 * - payload / template / address validation: permanent.
 * - Resend (ResendSendError.retryable): 429, 5xx and network errors retry; any other 4xx fails fast.
 * - SMTP (nodemailer responseCode): 5xx fails fast (rejected mailbox, auth); 4xx and connection errors retry.
 * Anything unrecognised retries.
 */
export function isPermanentMailError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { responseCode?: unknown; retryable?: unknown };
  const permanentNames = [
    'UnknownAuthMailTemplateError',
    'EmailValidationError',
    'InvalidAuthMailJobError',
  ];
  if (permanentNames.includes(e.name)) return true;
  if (typeof e.retryable === 'boolean') return !e.retryable;
  return typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600;
}

export class InvalidAuthMailJobError extends UnrecoverableError {
  constructor() {
    super('invalid auth mail job');
    this.name = 'InvalidAuthMailJobError';
  }
}

const KINDS = new Set<AuthMailJob['kind']>([
  'password_reset',
  'email_verification',
  'account_exists',
  'login_lockout',
  'invitation',
  'password_changed',
]);

export interface AuthMailJobRunner {
  handle(job: AuthMailJob): Promise<void>;
}

/**
 * The worker's processor. Transient errors are rethrown (BullMQ retries with backoff); permanent ones become
 * UnrecoverableError so the job fails without more attempts. Logs carry kind, job id, attempt and error class only.
 */
export function createAuthMailProcessor(handler: AuthMailJobRunner, log?: MailLog) {
  return async (job: Pick<Job<AuthMailJob>, 'id' | 'data' | 'attemptsMade' | 'opts'>) => {
    const data = job.data as AuthMailJob | undefined;
    if (!data || typeof data !== 'object' || !KINDS.has(data.kind))
      throw new InvalidAuthMailJobError();
    try {
      await handler.handle(minimalAuthMailPayload(data));
    } catch (err) {
      const permanent = isPermanentMailError(err);
      const attempts = job.opts?.attempts ?? 1;
      const final = permanent || job.attemptsMade + 1 >= attempts;
      log?.[final ? 'error' : 'warn'](
        { kind: data.kind, jobId: job.id, attempt: job.attemptsMade + 1, err: safeMailError(err) },
        final ? 'auth mail delivery failed permanently' : 'auth mail delivery failed; will retry',
      );
      if (permanent) throw new UnrecoverableError('auth mail permanent failure');
      // Rethrow a sanitized error: BullMQ stores failedReason in Redis.
      throw new Error(
        `auth mail transient failure (${err instanceof Error ? err.name : 'unknown'})`,
      );
    }
  };
}

/** BullMQ consumer for the auth-mail queue. Returns the Worker so the caller can close it on shutdown. */
export function startAuthMailWorker(
  handler: AuthMailJobRunner,
  conn: AuthMailQueueConnection & { concurrency?: number },
  log?: MailLog,
): Worker<AuthMailJob> {
  const processor = createAuthMailProcessor(handler, log);
  const worker = new Worker<AuthMailJob>(AUTH_MAIL_QUEUE, (job) => processor(job), {
    connection: { url: conn.redisUrl, maxRetriesPerRequest: null },
    concurrency: conn.concurrency ?? 5,
    ...(conn.prefix ? { prefix: conn.prefix } : {}),
  });
  worker.on('error', (err) => log?.error({ err: safeMailError(err) }, 'auth mail worker error'));
  return worker;
}
