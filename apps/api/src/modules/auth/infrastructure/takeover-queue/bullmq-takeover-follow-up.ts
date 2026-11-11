import { createHash } from 'node:crypto';
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from 'bullmq';
import { AUTH_TAKEOVER_FOLLOW_UP_DLQ, AUTH_TAKEOVER_FOLLOW_UP_QUEUE } from '@meetops/contracts';
import {
  TAKEOVER_FOLLOW_UP_KINDS,
  isTakeoverFollowUpKind,
  type TakeoverFollowUpJob,
  type TakeoverFollowUpQueue,
  type TakeoverFollowUpRunner,
} from '../../domain/takeover-follow-up.js';

/**
 * #463 review: durable retries of account-takeover follow-ups (realtime kick, extension/desktop token families, push
 * devices, and the set-password mail if enqueueing it failed). Replaces the in-process timers, which a restart or
 * deploy dropped. Same conventions as the auth-mail queue
 * (ADR-013): ids-only payloads, deterministic job ids without ':', bounded attempts with exponential backoff, and the
 * worker's `<queue>-dlq` dead-letter pattern (see apps/worker transcription-retry) once the attempts are used up.
 */
export const TAKEOVER_FOLLOW_UP_QUEUE = AUTH_TAKEOVER_FOLLOW_UP_QUEUE;
export const TAKEOVER_FOLLOW_UP_DLQ = AUTH_TAKEOVER_FOLLOW_UP_DLQ;

/**
 * First run 5 s after the request (like the old timer), then exponential backoff: 5, 10, 20, 40, 80 s (about 2.5 min
 * in total, the old 5 s / 30 s / 2 min chain). Completed jobs are removed at once, so the job id dedupes only while a
 * follow-up is pending; failed jobs stay 7 days for inspection, the DLQ entry is the durable record. The job id includes
 * a time bucket so a failed job does not block a later takeover of the same user and kind for those 7 days.
 */
export const TAKEOVER_FOLLOW_UP_JOB_OPTIONS = {
  delay: 5_000,
  attempts: 6,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} as const satisfies JobsOptions;

const FOLLOW_UP_KIND_ALT = TAKEOVER_FOLLOW_UP_KINDS.join('|');
export const TAKEOVER_JOB_ID_RE = new RegExp(
  `^takeover_(${FOLLOW_UP_KIND_ALT})_([0-9]{1,12})_([0-9a-f]{40})$`,
);
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ERROR_NAME_RE = /^[\w.-]{1,64}$/;

/** 10 min: covers the ~2.5 min retry window, so one takeover still dedupes. */
export const TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS = 10 * 60 * 1000;

export function takeoverFollowUpJobIdBucket(nowMs: number): number {
  return Math.floor(nowMs / TAKEOVER_FOLLOW_UP_JOB_ID_BUCKET_MS);
}

/** Deterministic id at an explicit bucket: `takeover_<kind>_<bucket>_<sha256(kind, userId, bucket)[:40]>`. */
export function takeoverFollowUpJobIdAt(job: TakeoverFollowUpJob, bucket: number): string {
  const h = createHash('sha256')
    .update(`${job.kind}\u0000${job.userId}\u0000${bucket}`)
    .digest('hex')
    .slice(0, 40);
  const id = `takeover_${job.kind}_${bucket}_${h}`;
  if (!TAKEOVER_JOB_ID_RE.test(id))
    throw new Error('takeover follow-up job id has an unsafe shape');
  return id;
}

/** Deterministic job id per user, kind and time bucket (no ':'). */
export function takeoverFollowUpJobId(job: TakeoverFollowUpJob, nowMs = Date.now()): string {
  return takeoverFollowUpJobIdAt(job, takeoverFollowUpJobIdBucket(nowMs));
}

/**
 * The stored id when it is a well-formed id for this payload (any bucket). Used by DLQ re-drive so an entry from an
 * earlier bucket still validates after the clock has moved on.
 */
export function matchingTakeoverFollowUpJobId(
  job: TakeoverFollowUpJob,
  jobId: unknown,
): string | undefined {
  if (typeof jobId !== 'string') return undefined;
  const m = TAKEOVER_JOB_ID_RE.exec(jobId);
  if (!m || m[1] !== job.kind) return undefined;
  const expected = takeoverFollowUpJobIdAt(job, Number(m[2]));
  return expected === jobId ? jobId : undefined;
}

/** Safe error class/name (or typeof) for DLQ `errorType` and logs: never a message. */
export function safeErrorType(err: unknown): string {
  if (err instanceof Error && SAFE_ERROR_NAME_RE.test(err.name)) return err.name;
  return err instanceof Error ? 'Error' : typeof err;
}

/** DLQ entry id for a dead-lettered follow-up (same `dlq_` convention as the transcription DLQ). */
export const takeoverDeadLetterJobId = (jobId: string) => `dlq_${jobId}`;

/** Exactly the two fields a job may carry; anything else is dropped (payload minimisation). */
export function minimalTakeoverFollowUpPayload(job: TakeoverFollowUpJob): TakeoverFollowUpJob {
  return { userId: job.userId, kind: job.kind };
}

/** Error class and a safe code only: BullMQ stores failure reasons in Redis and logs ship elsewhere. */
export function safeFollowUpError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const code = (err as { code?: unknown }).code;
  return {
    type: err.name,
    ...(typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? { code } : {}),
  };
}

export interface FollowUpLog {
  error(obj: Record<string, unknown>, msg: string): void;
  warn?(obj: Record<string, unknown>, msg: string): void;
}

/** Minimal producer surface (BullMQ Queue#add), injectable for tests. */
export interface TakeoverFollowUpProducer {
  add(name: string, data: TakeoverFollowUpJob, opts: JobsOptions): Promise<unknown>;
  close?(): Promise<void>;
}

/** Durable TakeoverFollowUpQueue. `enqueue` rejects on a Redis failure so AuthService can log and fall back. */
export class BullMqTakeoverFollowUpQueue implements TakeoverFollowUpQueue {
  constructor(private readonly producer: TakeoverFollowUpProducer) {}

  async enqueue(job: TakeoverFollowUpJob): Promise<void> {
    if (!isTakeoverFollowUpKind(job.kind) || !USER_ID_RE.test(job.userId))
      throw new Error('invalid takeover follow-up job');
    await this.producer.add(job.kind, minimalTakeoverFollowUpPayload(job), {
      ...TAKEOVER_FOLLOW_UP_JOB_OPTIONS,
      jobId: takeoverFollowUpJobId(job),
    });
  }

  async close(): Promise<void> {
    await this.producer.close?.();
  }
}

export interface TakeoverFollowUpConnection {
  redisUrl: string;
  /** BullMQ key prefix (AUTH_MAIL_QUEUE_PREFIX, shared with the auth-mail queue); default `bull`. */
  prefix?: string | undefined;
}

/** BullMQ queue/worker options for a connection: the Redis URL plus the optional key prefix. */
export const connectionOf = (conn: TakeoverFollowUpConnection) => ({
  connection: { url: conn.redisUrl, maxRetriesPerRequest: null },
  ...(conn.prefix ? { prefix: conn.prefix } : {}),
});

/** BullMQ producer, created lazily on the first enqueue so building deps opens no connection. */
export function createTakeoverFollowUpProducer(
  conn: TakeoverFollowUpConnection,
  onError: (err: Error) => void = () => {},
): TakeoverFollowUpProducer {
  let queue: Queue<TakeoverFollowUpJob> | undefined;
  const get = () => {
    if (!queue) {
      queue = new Queue<TakeoverFollowUpJob>(TAKEOVER_FOLLOW_UP_QUEUE, connectionOf(conn));
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

export class InvalidTakeoverFollowUpJobError extends UnrecoverableError {
  constructor() {
    super('invalid takeover follow-up job');
    this.name = 'InvalidTakeoverFollowUpJobError';
  }
}

/** The `{ userId, kind }` payload when valid, else null (extra fields are dropped). */
export function validJob(data: unknown): TakeoverFollowUpJob | null {
  if (!data || typeof data !== 'object') return null;
  const { userId, kind } = data as Record<string, unknown>;
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId) || !isTakeoverFollowUpKind(kind))
    return null;
  return { userId, kind };
}

type ProcessorJob = Pick<Job<TakeoverFollowUpJob>, 'id' | 'data' | 'attemptsMade' | 'opts'>;

/**
 * The worker's processor: validates the payload (UnrecoverableError when invalid) and runs the idempotent follow-up.
 * A failure is rethrown sanitized, so BullMQ retries with backoff and stores no detail in Redis.
 */
export function createTakeoverFollowUpProcessor(runner: TakeoverFollowUpRunner, log?: FollowUpLog) {
  return async (job: ProcessorJob) => {
    const data = validJob(job.data);
    if (!data) throw new InvalidTakeoverFollowUpJobError();
    try {
      await runner.runTakeoverFollowUp(data);
    } catch (err) {
      log?.warn?.(
        {
          event: 'auth.takeover.follow_up_retry_failed',
          userId: data.userId,
          kind: data.kind,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          err: safeFollowUpError(err),
        },
        'account takeover follow-up attempt failed',
      );
      const wrapped = new Error(`takeover follow-up failed (${safeErrorType(err)})`);
      wrapped.name = safeErrorType(err);
      throw wrapped;
    }
  };
}

export interface TakeoverDeadLetter {
  userId: string;
  kind: TakeoverFollowUpJob['kind'];
  jobId: string | undefined;
  attemptsMade: number;
  errorType: string;
  failedAt: string;
}

/** Minimal DLQ surface (BullMQ Queue#add), injectable for tests. */
export interface TakeoverDeadLetterQueue {
  add(name: string, data: TakeoverDeadLetter, opts: JobsOptions): Promise<unknown>;
}

type FailedJob = Pick<Job<TakeoverFollowUpJob>, 'id' | 'data' | 'attemptsMade' | 'opts'>;

/** True once a failed job will not run again: unrecoverable, or every attempt used (BullMQ counts this one). */
export function isFollowUpExhausted(job: FailedJob, err: unknown): boolean {
  if (err instanceof UnrecoverableError) return true;
  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}

/**
 * BullMQ `failed` handler. A follow-up whose attempts are used up is dead-lettered (deduped by `dlq_<jobId>`, never
 * auto-removed) and `auth.takeover.follow_up_abandoned` is logged at error level for alerting. Returns whether it
 * dead-lettered. Never throws.
 */
export async function handleTakeoverFollowUpFailure(
  job: FailedJob | undefined,
  err: unknown,
  deps: { dlq: TakeoverDeadLetterQueue; log?: FollowUpLog | undefined; now?: () => Date },
): Promise<boolean> {
  if (!job || !isFollowUpExhausted(job, err)) return false;
  const data = validJob(job.data);
  if (!data) {
    deps.log?.error({ jobId: job.id }, 'invalid takeover follow-up job dropped');
    return false;
  }
  const entry: TakeoverDeadLetter = {
    ...data,
    jobId: job.id,
    attemptsMade: job.attemptsMade,
    errorType: safeErrorType(err),
    failedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const log = { userId: data.userId, kind: data.kind, jobId: job.id };
  try {
    await deps.dlq.add('takeover_follow_up_dead_letter', entry, {
      jobId: takeoverDeadLetterJobId(job.id ?? takeoverFollowUpJobId(data)),
      removeOnComplete: false,
      removeOnFail: false,
    });
  } catch (e) {
    deps.log?.error(
      { ...log, err: safeFollowUpError(e) },
      'takeover follow-up dead-letter enqueue failed',
    );
  }
  deps.log?.error(
    {
      event: 'auth.takeover.follow_up_abandoned',
      ...log,
      steps: [data.kind],
      attemptsMade: job.attemptsMade,
    },
    'account takeover follow-up still failing after deferred retries; dead-lettered',
  );
  return true;
}

/** BullMQ consumer plus its DLQ producer. `close` stops both (call on shutdown). */
export function startTakeoverFollowUpWorker(
  runner: TakeoverFollowUpRunner,
  conn: TakeoverFollowUpConnection & { concurrency?: number },
  log?: FollowUpLog,
  deadLetters?: TakeoverDeadLetterQueue,
): { worker: Worker<TakeoverFollowUpJob>; close(): Promise<void> } {
  const processor = createTakeoverFollowUpProcessor(runner, log);
  const ownDlq = deadLetters
    ? undefined
    : new Queue<TakeoverDeadLetter>(TAKEOVER_FOLLOW_UP_DLQ, connectionOf(conn));
  const dlq = deadLetters ?? ownDlq!;
  const worker = new Worker<TakeoverFollowUpJob>(
    TAKEOVER_FOLLOW_UP_QUEUE,
    (job) => processor(job),
    { ...connectionOf(conn), concurrency: conn.concurrency ?? 5 },
  );
  worker.on('failed', (job, err) => {
    void handleTakeoverFollowUpFailure(job, err, { dlq, log });
  });
  worker.on('error', (err) =>
    log?.error({ err: safeFollowUpError(err) }, 'takeover follow-up worker error'),
  );
  return {
    worker,
    close: async () => {
      await worker.close();
      await ownDlq?.close();
    },
  };
}
