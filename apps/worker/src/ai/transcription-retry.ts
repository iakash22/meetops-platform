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
  /**
   * Per-meeting DLQ index, written before the DLQ add. A failed index write is logged and the DLQ add still happens:
   * the index is only trusted for "still dead-lettered", never for "nothing left", so a missing member cannot clear
   * the meeting (see handleTranscriptionSuccess).
   */
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
        await deps.index?.clear(organizationId, meetingId);
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
    // Not fatal: the DLQ add below is the durable record, and the success path confirms "nothing left" with a full
    // DLQ scan, so a missing index member can never clear the meeting.
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
 * Per-meeting index of DLQ job ids: a Redis ZSET per org + meeting, scored by the time each entry was added.
 * It answers only "is something of this meeting still dead-lettered?" (true = definitely blocked). A false answer is
 * NOT trusted: the caller confirms with a full DLQ scan before clearing (so a failed index write, an expired key or
 * a pruned member can only cost a scan, never clear the meeting early).
 * - Entries younger than the grace period always count as dead-lettered (the DLQ add may not have landed yet).
 * - Older entries whose DLQ job is gone or no longer waiting (redriven, removed) are pruned atomically, only if
 *   their score is still old (a concurrent re-add refreshes the score and survives).
 * - The key's TTL is refreshed on every write; `clear` deletes it once the meeting leaves transcription_delayed.
 *   DLQ entries are kept until redriven (no retention limit), so the TTL cannot outlive them; an expired key only
 *   forces the confirming scan.
 */
export interface DeadLetterIndex {
  add(organizationId: string, meetingId: string, dlqJobId: string): Promise<void>;
  /** True when a DLQ job other than `excludeDlqJobIds` is (or may still be, within the grace period) dead-lettered. */
  hasLive(
    organizationId: string,
    meetingId: string,
    excludeDlqJobIds: readonly string[],
  ): Promise<boolean>;
  clear(organizationId: string, meetingId: string): Promise<void>;
}

export const deadLetterIndexKey = (organizationId: string, meetingId: string) =>
  `meetops:transcription-dlq:meeting:${organizationId}:${meetingId}`;

/** Entries younger than this always count as dead-lettered. */
export const DEAD_LETTER_INDEX_GRACE_MS = 120_000;
/** Key TTL, refreshed on every write. */
export const DEAD_LETTER_INDEX_TTL_MS = 30 * 24 * 3600_000;

/** ZREM only if the member's score is still <= cutoff (atomic; a concurrent re-add with a new score survives). */
const PRUNE_IF_OLD = `local s = redis.call('ZSCORE', KEYS[1], ARGV[1])
if s and tonumber(s) <= tonumber(ARGV[2]) then return redis.call('ZREM', KEYS[1], ARGV[1]) end
return 0`;

export type DeadLetterIndexRedis = {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

/** Redis ZSET index. A read costs one ZRANGE plus at most one state lookup per entry of THIS meeting. */
export function createRedisDeadLetterIndex(
  redis: DeadLetterIndexRedis,
  dlq: { getJobState(jobId: string): Promise<string> },
  opts: { now?: () => number; graceMs?: number; ttlMs?: number } = {},
): DeadLetterIndex {
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? DEAD_LETTER_INDEX_GRACE_MS;
  const ttlMs = opts.ttlMs ?? DEAD_LETTER_INDEX_TTL_MS;
  const live = new Set<string>(DEAD_LETTER_STATES);
  return {
    async add(o, m, id) {
      const key = deadLetterIndexKey(o, m);
      await redis.zadd(key, now(), id);
      await redis.pexpire(key, ttlMs);
    },
    async hasLive(o, m, exclude) {
      const key = deadLetterIndexKey(o, m);
      const flat = await redis.zrange(key, 0, -1, 'WITHSCORES');
      const cutoff = now() - graceMs;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const id = flat[i]!;
        const addedAt = Number(flat[i + 1]);
        if (exclude.includes(id)) continue;
        if (addedAt > cutoff) return true; // in its grace period: the DLQ add may still be in flight
        if (live.has(await dlq.getJobState(id))) return true;
        await redis.eval(PRUNE_IF_OLD, 1, key, id, cutoff);
      }
      return false;
    },
    clear: async (o, m) => void (await redis.del(deadLetterIndexKey(o, m))),
  };
}

/**
 * A transcription attempt succeeded: a meeting parked in `transcription_delayed` goes back to `processing`, but only
 * when no OTHER chunk of that meeting is still dead-lettered.
 * 1. Status first: a meeting that is not `transcription_delayed` (the normal case) returns without touching the DLQ.
 * 2. The per-meeting index: a live (or in-grace) sibling keeps the meeting delayed without any scan.
 * 3. Otherwise a full DLQ scan confirms before clearing. This runs at most about once per delayed meeting (it clears
 *    it), and it makes a failed or expired index safe.
 * Any read error, or no way to confirm (no DLQ lister), leaves the meeting delayed. Never fails the job.
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
  if (!organizationId || !meetingId || !deps.status || !deps.deadLetters) return;
  const log = { organizationId, meetingId, jobId: job?.id };
  try {
    if (!(await deps.status.isDelayed(organizationId, meetingId))) return;
    const own = recordingId ? [deadLetterJobId(job?.id, recordingId, chunkIndex)] : [];
    if (deps.index && (await deps.index.hasLive(organizationId, meetingId, own))) return;
    if (meetingHasDeadLetters(await deps.deadLetters(), organizationId, meetingId, [job?.id]))
      return;
  } catch {
    deps.logger.error(log, 'transcription dead-letter lookup failed; meeting left delayed');
    return;
  }
  try {
    await deps.status.clearDelayed(organizationId, meetingId, 'processing');
  } catch {
    deps.logger.error(log, 'transcription delayed-status clear failed');
    return;
  }
  try {
    await deps.index?.clear(organizationId, meetingId);
  } catch {
    deps.logger.warn(log, 'transcription dead-letter index clear failed');
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
