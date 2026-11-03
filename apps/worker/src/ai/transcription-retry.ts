import { withOrganizationContext, type DatabaseClient } from '@meetops/database';
import { UnrecoverableError } from 'bullmq';
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

/** Sets the meeting to `transcription_delayed`. Must be idempotent and org-scoped. */
export interface TranscriptionDelayedStatus {
  markDelayed(organizationId: string, meetingId: string): Promise<void>;
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

export type DeadLetterDeps = {
  dlq: DeadLetterQueueLike;
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
  if (!job || !isRetryExhausted(job, err)) return false;
  const { organizationId, meetingId, recordingId } = job.data ?? {};
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
  try {
    await deps.dlq.add('transcription_dead_letter', entry, {
      jobId: `dlq:${job.id ?? `${recordingId}:${entry.chunkIndex ?? 0}`}`,
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

/**
 * Postgres status writer. Only moves a meeting that is still `processing` (never overwrites `completed`/`failed`),
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
  };
}
