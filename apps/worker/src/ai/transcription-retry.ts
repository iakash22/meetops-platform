import { withOrganizationContext, type DatabaseClient } from '@meetops/database';
import { UnrecoverableError, type JobType } from 'bullmq';
import { QUEUE_NAMES } from '@meetops/contracts';

/** Dead-letter queue for transcription jobs that used up their retries. Payload: ids and codes only. */
export const TRANSCRIPTION_DLQ = `${QUEUE_NAMES.transcription}-dlq`;
/** Custom BullMQ backoff type, resolved by `transcriptionBackoffStrategy` in the worker settings. */
export const TRANSCRIPTION_BACKOFF_TYPE = 'transcription-jitter';

export type TranscriptionRetryPolicy = {
  /** Total attempts including the first (1..20). */
  attempts: number;
  /** First retry delay before jitter. */
  baseDelayMs: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
};

export const DEFAULT_TRANSCRIPTION_RETRY: TranscriptionRetryPolicy = {
  attempts: 6,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
};

/**
 * Exponential backoff with "equal jitter": half the exponential step is fixed, half random. Keeps a minimum wait
 * (no thundering herd right after an outage) while spreading retries. `attemptsMade` is 1 after the first failure.
 */
export function transcriptionBackoffMs(
  attemptsMade: number,
  policy: Pick<
    TranscriptionRetryPolicy,
    'baseDelayMs' | 'maxDelayMs'
  > = DEFAULT_TRANSCRIPTION_RETRY,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(n - 1, 30));
  const half = exp / 2;
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(half + r * half);
}

/**
 * BullMQ `settings.backoffStrategy`. BullMQ calls it only for custom backoff types (built-ins such as `exponential`
 * never reach it), and every transcription job uses TRANSCRIPTION_BACKOFF_TYPE.
 */
export function transcriptionBackoffStrategy(
  policy: TranscriptionRetryPolicy = DEFAULT_TRANSCRIPTION_RETRY,
  random: () => number = Math.random,
) {
  return (attemptsMade: number): number => transcriptionBackoffMs(attemptsMade, policy, random);
}

/** Job options the producer (media worker) uses when enqueueing transcription jobs. */
export function transcriptionJobOptions(
  policy: TranscriptionRetryPolicy = DEFAULT_TRANSCRIPTION_RETRY,
) {
  return {
    attempts: policy.attempts,
    backoff: { type: TRANSCRIPTION_BACKOFF_TYPE },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    // Keep failed jobs long enough to inspect; the DLQ entry is the durable record.
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

export type TranscriptionDeadLetter = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  chunkIndex: number | undefined;
  jobId: string | undefined;
  errorCode: string;
  attemptsMade: number;
  failedAt: string;
};

/** Minimal Queue surface (keeps tests free of Redis). */
export type DeadLetterQueueLike = {
  add(
    name: string,
    data: TranscriptionDeadLetter,
    opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean },
  ): Promise<unknown>;
};

/** Moves a meeting into and out of `transcription_delayed`. Must be idempotent and org-scoped. */
export interface TranscriptionDelayedStatus {
  markDelayed(organizationId: string, meetingId: string): Promise<void>;
  /** True when the meeting is currently `transcription_delayed` (cheap primary-key read; success-path pre-check). */
  isDelayed(organizationId: string, meetingId: string): Promise<boolean>;
  /**
   * Leaves `transcription_delayed`: back to `processing` after a later attempt succeeds, or to `failed` on a final
   * (permanent) failure. Only moves a meeting that is still `transcription_delayed`.
   */
  clearDelayed(
    organizationId: string,
    meetingId: string,
    to: 'processing' | 'failed',
  ): Promise<void>;
}

/** Alert / notification hook. Receives ids and codes only, never transcript text or URLs. */
export type TranscriptionDelayedAlert = (event: TranscriptionDeadLetter) => void | Promise<void>;

export type DeadLetterLogger = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type FailedJobLike = {
  id?: string | undefined;
  data?: {
    organizationId?: string;
    meetingId?: string;
    recordingId?: string;
    chunkIndex?: number | undefined;
  };
  attemptsMade: number;
  opts?: { attempts?: number | undefined };
};

/**
 * True when BullMQ will not retry this job again: retries are used up, or the error was unrecoverable
 * (permanent errors are rejections, not outages, and are not dead-lettered).
 */
export function isRetryExhausted(job: FailedJobLike, err: unknown): boolean {
  if (err instanceof UnrecoverableError) return false;
  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}

/**
 * BullMQ (5.x) rejects a custom job id that contains ':', so the DLQ id uses a `dlq_` prefix and `_` separators.
 * Redrive lookups must use this same function.
 */
export const DLQ_JOB_ID_PREFIX = 'dlq_';
export function deadLetterJobId(
  jobId: string | undefined,
  recordingId: string,
  chunkIndex: number | undefined,
): string {
  const base = jobId ?? `${recordingId}_${chunkIndex ?? 0}`;
  return `${DLQ_JOB_ID_PREFIX}${base.replaceAll(':', '_')}`;
}

export type DeadLetterDeps = {
  dlq: DeadLetterQueueLike;
  /** Per-meeting DLQ index; updated before the DLQ add so a partial failure only leaves a stale (safe) member. */
  index?: DeadLetterIndex | undefined;
  status?: TranscriptionDelayedStatus | undefined;
  alert?: TranscriptionDelayedAlert | undefined;
  logger: DeadLetterLogger;
  now?: () => Date;
};

/**
 * Handle a failed transcription attempt. Only a retryable failure whose retries are used up is dead-lettered:
 * the DLQ entry is added (deduped by job id), the meeting is marked `transcription_delayed`, and the alert hook runs.
 * Each step is best-effort and isolated, so one failing step never hides the others. Returns whether it dead-lettered.
 */
export async function handleTranscriptionFailure(
  job: FailedJobLike | undefined,
  err: unknown,
  deps: DeadLetterDeps,
): Promise<boolean> {
  if (!job) return false;
  const { organizationId, meetingId, recordingId } = job.data ?? {};
  if (err instanceof UnrecoverableError) {
    // Final, permanent failure: a meeting parked in transcription_delayed (e.g. a redriven chunk) moves to failed.
    if (organizationId && meetingId) {
      try {
        await deps.status?.clearDelayed(organizationId, meetingId, 'failed');
      } catch {
        deps.logger.error(
          { organizationId, meetingId, recordingId, jobId: job.id },
          'transcription delayed-status clear failed',
        );
      }
    }
    return false;
  }
  if (!isRetryExhausted(job, err)) return false;
  if (!organizationId || !meetingId || !recordingId) return false;
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : 'provider_unavailable';
  const entry: TranscriptionDeadLetter = {
    organizationId,
    meetingId,
    recordingId,
    chunkIndex: job.data?.chunkIndex,
    jobId: job.id,
    errorCode: code,
    attemptsMade: job.attemptsMade,
    failedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const log = { organizationId, meetingId, recordingId, jobId: job.id, errorCode: code };
  const dlqJobId = deadLetterJobId(job.id, recordingId, entry.chunkIndex);
  try {
    await deps.index?.add(organizationId, meetingId, dlqJobId);
  } catch {
    deps.logger.error(log, 'transcription dead-letter index write failed');
  }
  try {
    await deps.dlq.add('transcription_dead_letter', entry, {
      jobId: dlqJobId,
      removeOnComplete: false,
      removeOnFail: false,
    });
  } catch {
    deps.logger.error(log, 'transcription dead-letter enqueue failed');
  }
  try {
    await deps.status?.markDelayed(organizationId, meetingId);
  } catch {
    deps.logger.error(log, 'transcription delayed-status write failed');
  }
  try {
    await deps.alert?.(entry);
  } catch {
    deps.logger.warn(log, 'transcription delayed alert hook failed');
  }
  // Error level so log-based alerting (P9 monitoring) can page on it.
  deps.logger.error(
    { ...log, attemptsMade: job.attemptsMade },
    'transcription delayed: retries exhausted, job dead-lettered',
  );
  return true;
}

/** States a DLQ entry can be in while it still counts as dead-lettered (BullMQ). */
export const DEAD_LETTER_STATES: JobType[] = ['waiting', 'delayed', 'paused', 'prioritized'];

type DeadLetterRef = { id?: string | undefined; data: TranscriptionDeadLetter };

/**
 * Shared guard (worker success path and the #420 redrive): true when any DLQ entry for this org + meeting remains,
 * ignoring entries for `excludeJobIds` (the job that just succeeded / was just re-queued).
 */
export function meetingHasDeadLetters(
  entries: readonly DeadLetterRef[],
  organizationId: string,
  meetingId: string,
  excludeJobIds: readonly (string | undefined)[] = [],
): boolean {
  return entries.some(
    (e) =>
      e.data.organizationId === organizationId &&
      e.data.meetingId === meetingId &&
      !(e.data.jobId !== undefined && excludeJobIds.includes(e.data.jobId)),
  );
}

/** Lists the current DLQ entries (all orgs). */
export type DeadLetterLister = () => Promise<readonly DeadLetterRef[]>;

/** Lister backed by the real BullMQ DLQ queue. */
export function queueDeadLetterLister(queue: {
  getJobs(types: JobType[]): Promise<Array<DeadLetterRef | undefined>>;
}): DeadLetterLister {
  return async () =>
    (await queue.getJobs(DEAD_LETTER_STATES)).filter((j): j is DeadLetterRef => !!j);
}

/**
 * Per-meeting index of DLQ job ids (a Redis set per org + meeting), so the success path never scans the whole DLQ.
 * Members are added before the DLQ add; members whose DLQ job is gone or no longer waiting (redriven, removed) are
 * pruned on read, so redrive does not have to maintain it (it may also call `remove`).
 */
export interface DeadLetterIndex {
  add(organizationId: string, meetingId: string, dlqJobId: string): Promise<void>;
  remove(organizationId: string, meetingId: string, dlqJobId: string): Promise<void>;
  /** True when a dead-lettered DLQ job other than `excludeDlqJobIds` exists for the meeting. */
  hasOther(
    organizationId: string,
    meetingId: string,
    excludeDlqJobIds: readonly string[],
  ): Promise<boolean>;
}

export const deadLetterIndexKey = (organizationId: string, meetingId: string) =>
  `meetops:transcription-dlq:meeting:${organizationId}:${meetingId}`;

/** Redis-set index. Reads cost O(entries for this meeting): one SMEMBERS plus one state lookup per member. */
export function createRedisDeadLetterIndex(
  redis: {
    sadd(key: string, member: string): Promise<unknown>;
    srem(key: string, member: string): Promise<unknown>;
    smembers(key: string): Promise<string[]>;
  },
  dlq: { getJobState(jobId: string): Promise<string> },
): DeadLetterIndex {
  const live = new Set<string>(DEAD_LETTER_STATES);
  return {
    add: async (o, m, id) => void (await redis.sadd(deadLetterIndexKey(o, m), id)),
    remove: async (o, m, id) => void (await redis.srem(deadLetterIndexKey(o, m), id)),
    async hasOther(o, m, exclude) {
      const key = deadLetterIndexKey(o, m);
      for (const id of await redis.smembers(key)) {
        if (exclude.includes(id)) continue;
        if (live.has(await dlq.getJobState(id))) return true;
        await redis.srem(key, id); // stale: redriven, removed or never added
      }
      return false;
    },
  };
}

/**
 * A transcription attempt succeeded: a meeting parked in `transcription_delayed` goes back to `processing`, but only
 * when no OTHER chunk of that meeting is still dead-lettered.
 * 1. Status first: a meeting that is not `transcription_delayed` (the normal case) returns without touching the DLQ.
 * 2. Then the per-meeting index (or, if none is wired, a full DLQ scan as a fallback).
 * Any read error, or no way to check, leaves the meeting delayed (the safe side). Never fails the job.
 */
export async function handleTranscriptionSuccess(
  job: Pick<FailedJobLike, 'id' | 'data'> | undefined,
  deps: {
    status?: TranscriptionDelayedStatus | undefined;
    index?: DeadLetterIndex | undefined;
    deadLetters?: DeadLetterLister | undefined;
    logger: DeadLetterLogger;
  },
): Promise<void> {
  const { organizationId, meetingId, recordingId, chunkIndex } = job?.data ?? {};
  if (!organizationId || !meetingId || !deps.status) return;
  if (!deps.index && !deps.deadLetters) return;
  const log = { organizationId, meetingId, jobId: job?.id };
  try {
    if (!(await deps.status.isDelayed(organizationId, meetingId))) return;
    const blocked = deps.index
      ? await deps.index.hasOther(
          organizationId,
          meetingId,
          recordingId ? [deadLetterJobId(job?.id, recordingId, chunkIndex)] : [],
        )
      : meetingHasDeadLetters(await deps.deadLetters!(), organizationId, meetingId, [job?.id]);
    if (blocked) return;
  } catch {
    deps.logger.error(log, 'transcription dead-letter lookup failed; meeting left delayed');
    return;
  }
  try {
    await deps.status.clearDelayed(organizationId, meetingId, 'processing');
  } catch {
    deps.logger.error(log, 'transcription delayed-status clear failed');
  }
}

/**
 * Postgres status writer. This is the ONLY code path that writes or clears `transcription_delayed`.
 * Deploy order: migration `20261103180000_meeting_status_transcription_delayed` ships in the same release as this
 * code and `prisma migrate deploy` runs before the worker starts. If the value is missing anyway (migration not
 * applied), Postgres rejects the update (invalid enum input); `handleTranscriptionFailure` catches it, logs
 * `transcription delayed-status write failed`, and the DLQ entry and alert still happen.
 * Only moves a meeting that is still `processing` (never overwrites `completed`/`failed`),
 * inside `withOrganizationContext` (forced RLS) and filtered on organizationId.
 */
export function createPrismaTranscriptionDelayedStatus(
  opts: { client?: DatabaseClient } = {},
): TranscriptionDelayedStatus {
  return {
    markDelayed: (organizationId, meetingId) =>
      withOrganizationContext(
        organizationId,
        async (tx) => {
          await tx.meeting.updateMany({
            where: { id: meetingId, organizationId, status: 'processing', deletedAt: null },
            data: { status: 'transcription_delayed' },
          });
        },
        opts.client ? { client: opts.client } : {},
      ),
    isDelayed: (organizationId, meetingId) =>
      withOrganizationContext(
        organizationId,
        async (tx) =>
          (await tx.meeting.count({
            where: {
              id: meetingId,
              organizationId,
              status: 'transcription_delayed',
              deletedAt: null,
            },
          })) > 0,
        opts.client ? { client: opts.client } : {},
      ),
    clearDelayed: (organizationId, meetingId, to) =>
      withOrganizationContext(
        organizationId,
        async (tx) => {
          await tx.meeting.updateMany({
            where: {
              id: meetingId,
              organizationId,
              status: 'transcription_delayed',
              deletedAt: null,
            },
            data: { status: to },
          });
        },
        opts.client ? { client: opts.client } : {},
      ),
  };
}
