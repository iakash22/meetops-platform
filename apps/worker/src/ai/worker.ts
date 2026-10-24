import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAMES, type TranscriptionJobPayload } from '@meetops/contracts';
import { logger as baseLogger } from '@meetops/logger';
import { createRealtimePublisher, createRedisEmitter } from '../media/realtime.js';
import {
  processTranscriptionJob,
  TranscriptionJobError,
  type TranscriptionConsumerDeps,
  type TranscriptionJobResult,
} from './consumer.js';

export type TranscriptionWorkerConfig = { redisUrl: string; concurrency: number };

/** BullMQ processor: permanent errors become UnrecoverableError so BullMQ stops retrying. */
export function createTranscriptionProcessor(deps: TranscriptionConsumerDeps) {
  return async (job: Pick<Job<TranscriptionJobPayload>, 'id' | 'data' | 'name'>): Promise<TranscriptionJobResult> => {
    if (job.data?.kind !== 'transcribe_recording') throw new UnrecoverableError('transcription job failed: invalid_payload');
    try {
      return await processTranscriptionJob(job.data, deps, { jobId: job.id });
    } catch (err) {
      if (err instanceof TranscriptionJobError && !err.retryable) throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}

/**
 * Wire the AI transcription worker. Executor, repository, audio and actor resolvers are injected by the host because
 * apps/worker has no Prisma client or ai-core bootstrap yet (see PR open questions).
 */
export function startTranscriptionWorker(
  cfg: TranscriptionWorkerConfig,
  deps: Omit<TranscriptionConsumerDeps, 'realtime' | 'logger'> & Partial<Pick<TranscriptionConsumerDeps, 'realtime' | 'logger'>>,
) {
  const logger = deps.logger ?? baseLogger.child({ worker: QUEUE_NAMES.transcription });
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = deps.realtime ? undefined : conn();
  const realtime = deps.realtime ?? createRealtimePublisher(createRedisEmitter(emitterRedis!));
  const worker = new Worker<TranscriptionJobPayload, TranscriptionJobResult>(
    QUEUE_NAMES.transcription,
    createTranscriptionProcessor({ ...deps, realtime, logger }),
    { connection: conn(), concurrency: cfg.concurrency },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, errorCode: err instanceof TranscriptionJobError ? err.code : err?.name }, 'transcription job attempt failed'),
  );
  const close = async () => {
    await worker.close();
    emitterRedis?.disconnect();
  };
  return { worker, close };
}
