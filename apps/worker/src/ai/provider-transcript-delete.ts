/**
 * Best-effort deletion of a provider's transcript copy after ours is durably stored
 * (ADR-019; docs/research/ai-provider-due-diligence.md).
 *
 * Enqueued as its own BullMQ job with retries/backoff and a deterministic jobId per
 * provider transcript id (idempotent). 404 / already-deleted is success. Logs and
 * the failure hook carry ids and HTTP status codes only — never transcript content.
 */
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  AssemblyAIProvider,
  endpointPolicyFromEnv,
  loadAIEnv,
  toAIError,
  type OnProviderTranscriptStored,
  type StoredProviderTranscript,
} from '@meetops/ai-core';
import { createAppRedis } from '../redis.js';
import { logger as baseLogger } from '../logger.js';
import type { TranscriptionLogger } from './consumer.js';

export const PROVIDER_TRANSCRIPT_DELETE_QUEUE = 'ai-provider-transcript-delete';
export const PROVIDER_TRANSCRIPT_DELETE_JOB_NAME = 'delete_provider_transcript';
export const PROVIDER_TRANSCRIPT_DELETE_ATTEMPTS = 5;
export const PROVIDER_TRANSCRIPT_DELETE_BACKOFF_MS = 2_000;

export type ProviderTranscriptDeleteJob = {
  organizationId: string;
  provider: 'assemblyai';
  providerTranscriptId: string;
  meetingId?: string | undefined;
  recordingId?: string | undefined;
};

export type ProviderTranscriptDeleteResult = {
  outcome: 'deleted' | 'already_deleted';
  httpStatus: number;
};

/** Minimal BullMQ `Queue` surface so unit tests stay off Redis. */
export type ProviderTranscriptDeleteQueueLike = {
  add(
    name: string,
    data: ProviderTranscriptDeleteJob,
    opts: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: { age: number };
      removeOnFail: { age: number };
    },
  ): Promise<unknown>;
};

export type ProviderTranscriptDeleter = {
  deleteTranscript(id: string, signal?: AbortSignal): Promise<ProviderTranscriptDeleteResult>;
};

export type ProviderTranscriptDeleteFinalFailure = {
  organizationId: string;
  provider: string;
  providerTranscriptId: string;
  httpStatus?: number | undefined;
  errorCode?: string | undefined;
};

const DAY_S = 24 * 3600;
const failedByProvider = new Map<string, number>();

export function isProviderTranscriptDeleteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.AI_PROVIDER_TRANSCRIPT_DELETE_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);
}

export function providerTranscriptDeleteJobId(
  provider: string,
  providerTranscriptId: string,
): string {
  return `provider-transcript-delete__${provider}__${providerTranscriptId}`;
}

export function incProviderTranscriptDeleteFailure(provider: string): void {
  failedByProvider.set(provider, (failedByProvider.get(provider) ?? 0) + 1);
}

export function providerTranscriptDeleteFailureCounts(): Record<string, number> {
  return Object.fromEntries(failedByProvider);
}

export function resetProviderTranscriptDeleteFailureCounts(): void {
  failedByProvider.clear();
}

/** Prometheus text for final delete failures (labels: provider only, no ids or content). */
export function renderProviderTranscriptDeleteMetrics(): string {
  const lines = [
    '# HELP meetops_provider_transcript_delete_failures_total ' +
      'Final failures deleting a provider transcript copy.',
    '# TYPE meetops_provider_transcript_delete_failures_total counter',
  ];
  const entries = [...failedByProvider.entries()];
  if (entries.length === 0) {
    lines.push('meetops_provider_transcript_delete_failures_total{provider="assemblyai"} 0');
  } else {
    for (const [provider, n] of entries) {
      const p = provider.replace(/"/g, '\\"');
      lines.push(`meetops_provider_transcript_delete_failures_total{provider="${p}"} ${n}`);
    }
  }
  return lines.join('\n') + '\n';
}

function isDuplicateJobError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already (exists|waiting|active|delayed|completed|paused|in the queue)|Job with this id/i.test(
    msg,
  );
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = err.status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export async function enqueueProviderTranscriptDelete(
  queue: ProviderTranscriptDeleteQueueLike,
  payload: ProviderTranscriptDeleteJob,
  opts: { enabled?: boolean | undefined } = {},
): Promise<{ enqueued: boolean; reason?: 'disabled' | 'duplicate' | 'missing_id' }> {
  if (!(opts.enabled ?? isProviderTranscriptDeleteEnabled())) {
    return { enqueued: false, reason: 'disabled' };
  }
  if (!payload.providerTranscriptId) {
    return { enqueued: false, reason: 'missing_id' };
  }
  try {
    await queue.add(PROVIDER_TRANSCRIPT_DELETE_JOB_NAME, payload, {
      jobId: providerTranscriptDeleteJobId(payload.provider, payload.providerTranscriptId),
      attempts: PROVIDER_TRANSCRIPT_DELETE_ATTEMPTS,
      backoff: { type: 'exponential', delay: PROVIDER_TRANSCRIPT_DELETE_BACKOFF_MS },
      removeOnComplete: { age: 7 * DAY_S },
      removeOnFail: { age: 14 * DAY_S },
    });
    return { enqueued: true };
  } catch (err) {
    if (isDuplicateJobError(err)) return { enqueued: false, reason: 'duplicate' };
    throw err;
  }
}

export function createQueueProviderTranscriptDeleteTrigger(
  queue: ProviderTranscriptDeleteQueueLike,
  opts: {
    enabled?: boolean | undefined;
    logger?: TranscriptionLogger | undefined;
  } = {},
): OnProviderTranscriptStored {
  return async (info: StoredProviderTranscript) => {
    if (info.provider !== 'assemblyai') return;
    if (!info.providerJobId) {
      // Legacy rows stored before provider_job_id was persisted. Ids and codes only.
      opts.logger?.info(
        {
          organizationId: info.organizationId,
          meetingId: info.meetingId,
          recordingId: info.recordingId,
          chunkIndex: info.chunkIndex,
          provider: info.provider,
        },
        'provider transcript delete skipped: no provider job id',
      );
      return;
    }
    await enqueueProviderTranscriptDelete(
      queue,
      {
        organizationId: info.organizationId,
        provider: 'assemblyai',
        providerTranscriptId: info.providerJobId,
        meetingId: info.meetingId,
        recordingId: info.recordingId,
      },
      opts,
    );
  };
}

export type ResolveProviderJobId = (q: {
  organizationId: string;
  meetingId?: string | undefined;
  recordingId?: string | undefined;
}) => Promise<string | undefined>;

/** Looks up `transcripts.provider_job_id` on the revision-0 anchor (existing column). */
export function createRepositoryProviderJobIdLookup(repo: {
  withOrgContext: <T>(
    organizationId: string,
    fn: (r: {
      getProviderJobId: (meetingId: string, recordingId: string) => Promise<string | undefined>;
    }) => Promise<T>,
  ) => Promise<T>;
}): ResolveProviderJobId {
  return async (q) => {
    if (!q.meetingId || !q.recordingId) return undefined;
    return repo.withOrgContext(q.organizationId, (r) =>
      r.getProviderJobId(q.meetingId!, q.recordingId!),
    );
  };
}

export type ProcessProviderTranscriptDeleteDeps = {
  resolveDeleter: (provider: string) => Promise<ProviderTranscriptDeleter>;
  /** Source of truth: the stored `transcripts.provider_job_id`. Null/missing => skip. */
  resolveProviderJobId: ResolveProviderJobId;
  logger: TranscriptionLogger;
  onFinalFailure?: ((info: ProviderTranscriptDeleteFinalFailure) => void) | undefined;
};

export async function processProviderTranscriptDelete(
  data: ProviderTranscriptDeleteJob,
  deps: ProcessProviderTranscriptDeleteDeps,
  ctx: { isFinalAttempt: boolean; jobId?: string | undefined; signal?: AbortSignal | undefined },
): Promise<ProviderTranscriptDeleteResult> {
  const baseLog = {
    organizationId: data.organizationId,
    provider: data.provider,
    meetingId: data.meetingId,
    recordingId: data.recordingId,
    jobId: ctx.jobId,
  };
  const storedId = await deps.resolveProviderJobId({
    organizationId: data.organizationId,
    meetingId: data.meetingId,
    recordingId: data.recordingId,
  });
  if (!storedId) {
    // Legacy rows, or the anchor was never written: skip cleanly, no transcript content, no invented id.
    deps.logger.info(baseLog, 'provider transcript delete skipped: no provider job id');
    return { outcome: 'already_deleted', httpStatus: 0 };
  }
  const log = { ...baseLog, providerTranscriptId: storedId };
  try {
    const deleter = await deps.resolveDeleter(data.provider);
    const result = await deleter.deleteTranscript(storedId, ctx.signal);
    deps.logger.info(
      { ...log, httpStatus: result.httpStatus, outcome: result.outcome },
      'provider transcript deleted',
    );
    return result;
  } catch (err) {
    const e = toAIError(err, data.provider);
    const failure: ProviderTranscriptDeleteFinalFailure = {
      organizationId: data.organizationId,
      provider: data.provider,
      providerTranscriptId: storedId,
      httpStatus: httpStatusOf(err),
      errorCode: e.code,
    };
    if (!e.retryable || ctx.isFinalAttempt) {
      deps.logger.error(failure, 'provider transcript delete failed');
      if (ctx.isFinalAttempt || !e.retryable) {
        incProviderTranscriptDeleteFailure(data.provider);
        deps.onFinalFailure?.(failure);
      }
      if (!e.retryable)
        throw new UnrecoverableError(`provider transcript delete failed: ${e.code}`);
    } else {
      deps.logger.warn(failure, 'provider transcript delete attempt failed');
    }
    throw e;
  }
}

export function createAssemblyAIDeleter(
  env: Record<string, string | undefined> = process.env,
  opts: { production?: boolean | undefined } = {},
): ProviderTranscriptDeleter {
  const { env: ai } = loadAIEnv(env);
  const policy = endpointPolicyFromEnv(ai, {
    production: opts.production ?? env.NODE_ENV === 'production',
  });
  const provider = new AssemblyAIProvider({ apiKey: env.ASSEMBLYAI_API_KEY, policy });
  return {
    deleteTranscript: (id, signal) => provider.deleteTranscript(id, signal),
  };
}

export function createDefaultDeleterResolver(
  env: Record<string, string | undefined> = process.env,
): ProcessProviderTranscriptDeleteDeps['resolveDeleter'] {
  return async (provider) => {
    if (provider !== 'assemblyai') {
      throw new UnrecoverableError(`provider transcript delete failed: unsupported_provider`);
    }
    return createAssemblyAIDeleter(env);
  };
}

export function createProviderTranscriptDeleteProcessor(deps: ProcessProviderTranscriptDeleteDeps) {
  return async (job: Job<ProviderTranscriptDeleteJob>) => {
    const attempts = job.opts.attempts ?? PROVIDER_TRANSCRIPT_DELETE_ATTEMPTS;
    return processProviderTranscriptDelete(job.data, deps, {
      jobId: job.id,
      isFinalAttempt: (job.attemptsMade ?? 0) + 1 >= attempts,
    });
  };
}

export type ProviderTranscriptDeleteWorkerConfig = {
  redisUrl: string;
  concurrency?: number | undefined;
};

export type RegisterProviderTranscriptDeleteOptions = {
  redisUrl?: string | undefined;
  concurrency?: number | undefined;
  resolveDeleter?: ProcessProviderTranscriptDeleteDeps['resolveDeleter'] | undefined;
  resolveProviderJobId?: ResolveProviderJobId | undefined;
  logger?: TranscriptionLogger | undefined;
  onFinalFailure?: ((info: ProviderTranscriptDeleteFinalFailure) => void) | undefined;
  start?: typeof startProviderTranscriptDeleteWorker | undefined;
};

export function startProviderTranscriptDeleteWorker(
  cfg: ProviderTranscriptDeleteWorkerConfig,
  deps: ProcessProviderTranscriptDeleteDeps,
) {
  const logger = deps.logger ?? baseLogger.child({ worker: PROVIDER_TRANSCRIPT_DELETE_QUEUE });
  const conn = () => createAppRedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<ProviderTranscriptDeleteJob, ProviderTranscriptDeleteResult>(
    PROVIDER_TRANSCRIPT_DELETE_QUEUE,
    createProviderTranscriptDeleteProcessor({ ...deps, logger }),
    { connection: conn(), concurrency: cfg.concurrency ?? 2 },
  );
  const close = async () => {
    await worker.close();
  };
  return { worker, close };
}

export function registerProviderTranscriptDeleteWorker(
  opts: RegisterProviderTranscriptDeleteOptions = {},
):
  | { registered: true; close: () => Promise<void> }
  | { registered: false; reason: 'missing_redis' } {
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  if (!redisUrl) return { registered: false, reason: 'missing_redis' };
  const logger = opts.logger ?? baseLogger.child({ worker: PROVIDER_TRANSCRIPT_DELETE_QUEUE });
  if (!opts.resolveProviderJobId) {
    throw new Error('provider transcript delete worker requires resolveProviderJobId');
  }
  const { close } = (opts.start ?? startProviderTranscriptDeleteWorker)(
    { redisUrl, concurrency: opts.concurrency },
    {
      resolveDeleter: opts.resolveDeleter ?? createDefaultDeleterResolver(),
      resolveProviderJobId: opts.resolveProviderJobId,
      logger,
      onFinalFailure: opts.onFinalFailure,
    },
  );
  return { registered: true, close };
}

export function createProviderTranscriptDeleteQueue(redisUrl: string): Queue {
  return new Queue(PROVIDER_TRANSCRIPT_DELETE_QUEUE, {
    connection: createAppRedis(redisUrl, { maxRetriesPerRequest: null }),
  });
}
