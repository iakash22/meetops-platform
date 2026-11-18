import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { createAppRedis } from '../redis.js';
import { QUEUE_NAMES, type TranscriptionJobPayload } from '@meetops/contracts';
import { logger as baseLogger } from '../logger.js';
import { createRealtimePublisher, createRedisEmitter } from '../media/realtime.js';
import {
  processTranscriptionJob,
  TranscriptionJobError,
  type TranscriptionConsumerDeps,
  type TranscriptionJobResult,
} from './consumer.js';
import { createQueueSummaryTrigger, SUMMARY_QUEUE } from './summary-trigger.js';
import { loadTranscriptionWorkerEnv, type TranscriptionWorkerEnv } from './env.js';
import {
  DEFAULT_TRANSCRIPTION_RETRY,
  TRANSCRIPTION_DLQ,
  handleTranscriptionFailure,
  handleTranscriptionSuccess,
  queueDeadLetterLister,
  createRedisDeadLetterIndex,
  type DeadLetterIndex,
  type DeadLetterLister,
  transcriptionBackoffStrategy,
  type DeadLetterQueueLike,
  type TranscriptionDelayedAlert,
  type TranscriptionDelayedStatus,
  type TranscriptionRetryPolicy,
} from './transcription-retry.js';

export type TranscriptionWorkerConfig = {
  redisUrl: string;
  concurrency: number;
  retry?: TranscriptionRetryPolicy | undefined;
};

/** Optional retry-exhaustion wiring: meeting status writer, alert hook, and a DLQ override (tests). */
export type TranscriptionDeadLetterDeps = {
  delayedStatus?: TranscriptionDelayedStatus | undefined;
  onTranscriptionDelayed?: TranscriptionDelayedAlert | undefined;
  deadLetterQueue?: DeadLetterQueueLike | undefined;
  /** DLQ lister for the success-path guard (tests). Defaults to the worker's own DLQ queue. */
  deadLetterLister?: DeadLetterLister | undefined;
  /** Per-meeting DLQ index (tests). Defaults to a Redis set index over the worker's own DLQ queue. */
  deadLetterIndex?: DeadLetterIndex | undefined;
};

/** BullMQ processor: permanent errors become UnrecoverableError so BullMQ stops retrying. */
export function createTranscriptionProcessor(deps: TranscriptionConsumerDeps) {
  return async (
    job: Pick<Job<TranscriptionJobPayload>, 'id' | 'data' | 'name'>,
  ): Promise<TranscriptionJobResult> => {
    if (job.data?.kind !== 'transcribe_recording')
      throw new UnrecoverableError('transcription job failed: invalid_payload');
    try {
      return await processTranscriptionJob(job.data, deps, { jobId: job.id });
    } catch (err) {
      if (err instanceof TranscriptionJobError && !err.retryable)
        throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}

/** Deps the host must inject (no Prisma/ai-core bootstrap in apps/worker yet). Geometry comes from env. */
export type TranscriptionHostDeps = Omit<
  TranscriptionConsumerDeps,
  'realtime' | 'logger' | 'geometry'
> &
  Partial<Pick<TranscriptionConsumerDeps, 'realtime' | 'logger' | 'geometry'>> &
  TranscriptionDeadLetterDeps;

export function startTranscriptionWorker(
  cfg: TranscriptionWorkerConfig,
  deps: TranscriptionHostDeps & { geometry: TranscriptionConsumerDeps['geometry'] },
) {
  const logger = deps.logger ?? baseLogger.child({ worker: QUEUE_NAMES.transcription });
  const conn = () => createAppRedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = deps.realtime ? undefined : conn();
  const realtime = deps.realtime ?? createRealtimePublisher(createRedisEmitter(emitterRedis!));
  // Default trigger: enqueue the meeting summary on QUEUE_NAMES.ai when a transcript becomes ready.
  // `summaryTrigger: undefined` in host deps keeps the default; pass a no-op trigger to opt out.
  const summaryQueue = deps.summaryTrigger
    ? undefined
    : new Queue(SUMMARY_QUEUE, { connection: conn() });
  const summaryTrigger = deps.summaryTrigger ?? createQueueSummaryTrigger(summaryQueue!);
  const worker = new Worker<TranscriptionJobPayload, TranscriptionJobResult>(
    QUEUE_NAMES.transcription,
    createTranscriptionProcessor({ ...deps, realtime, logger, summaryTrigger }),
    {
      connection: conn(),
      concurrency: cfg.concurrency,
      settings: {
        backoffStrategy: transcriptionBackoffStrategy(cfg.retry ?? DEFAULT_TRANSCRIPTION_RETRY),
      },
    },
  );
  const ownDlq = deps.deadLetterQueue
    ? undefined
    : new Queue(TRANSCRIPTION_DLQ, { connection: conn() });
  const dlq: DeadLetterQueueLike =
    deps.deadLetterQueue ?? (ownDlq as unknown as DeadLetterQueueLike);
  const deadLetterLister =
    deps.deadLetterLister ?? (ownDlq ? queueDeadLetterLister(ownDlq) : undefined);
  const indexRedis = deps.deadLetterIndex || !ownDlq ? undefined : conn();
  const deadLetterIndex =
    deps.deadLetterIndex ??
    (ownDlq && indexRedis ? createRedisDeadLetterIndex(indexRedis, ownDlq) : undefined);
  worker.on('failed', (job, err) => {
    logger.warn(
      { jobId: job?.id, errorCode: err instanceof TranscriptionJobError ? err.code : err?.name },
      'transcription job attempt failed',
    );
    void handleTranscriptionFailure(job, err, {
      dlq,
      index: deadLetterIndex,
      status: deps.delayedStatus,
      alert: deps.onTranscriptionDelayed,
      logger,
    });
  });
  worker.on('completed', (job) => {
    void handleTranscriptionSuccess(job, {
      status: deps.delayedStatus,
      index: deadLetterIndex,
      deadLetters: deadLetterLister,
      logger,
    });
  });
  const close = async () => {
    await worker.close();
    await ownDlq?.close();
    indexRedis?.disconnect();
    await summaryQueue?.close();
    emitterRedis?.disconnect();
  };
  return { worker, close };
}

export type RegisterTranscriptionWorkerOptions = {
  env?: TranscriptionWorkerEnv;
  /** Returns host deps (repository from @meetops/database's public entry, executor, audio resolver, audit), or undefined. */
  resolveDeps?: () => TranscriptionHostDeps | undefined;
  start?: typeof startTranscriptionWorker;
  logger?: Pick<TranscriptionConsumerDeps['logger'], 'info' | 'warn'>;
};

export type TranscriptionRegistration =
  | { registered: true; close: () => Promise<void> }
  | { registered: false; reason: 'disabled' | 'missing_dependencies' };

/**
 * Registers the BullMQ processor only when TRANSCRIPTION_WORKER_ENABLED=true AND a repository-backed deps set is
 * injectable. Otherwise nothing consumes QUEUE_NAMES.transcription and jobs stay queued.
 */
export function registerTranscriptionWorker(
  opts: RegisterTranscriptionWorkerOptions = {},
): TranscriptionRegistration {
  const env = opts.env ?? loadTranscriptionWorkerEnv();
  const logger = opts.logger ?? baseLogger;
  if (!env.enabled) {
    logger.info(
      { worker: QUEUE_NAMES.transcription },
      'transcription worker disabled (TRANSCRIPTION_WORKER_ENABLED=false)',
    );
    return { registered: false, reason: 'disabled' };
  }
  const deps = opts.resolveDeps?.();
  if (!deps) {
    logger.warn(
      { worker: QUEUE_NAMES.transcription },
      'transcription worker enabled but no repository implementation injected; not registered',
    );
    return { registered: false, reason: 'missing_dependencies' };
  }
  const { close } = (opts.start ?? startTranscriptionWorker)(
    { redisUrl: env.redisUrl, concurrency: env.concurrency, retry: env.retry },
    { ...deps, geometry: deps.geometry ?? { segmentSeconds: env.segmentSeconds } },
  );
  return { registered: true, close };
}
