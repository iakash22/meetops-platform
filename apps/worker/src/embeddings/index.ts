import { UnrecoverableError, Worker } from 'bullmq';
import { createAppRedis } from '../redis.js';
import { embedWithExecutor, type AIExecutor } from '@meetops/ai-core';
import { logger as baseLogger } from '../logger.js';
import { createPrismaEmbeddingRepository } from './prisma-repository.js';
import {
  EMBEDDINGS_QUEUE,
  EmbeddingRetryableError,
  runMeetingEmbeddings,
  type EmbeddingJobPayload,
  type EmbeddingLimits,
  type EmbeddingRepository,
} from './pipeline.js';

export * from './pipeline.js';
export { createPrismaEmbeddingRepository } from './prisma-repository.js';

export type EmbeddingsWorkerEnv = {
  enabled: boolean;
  concurrency: number;
  redisUrl: string;
  limits: EmbeddingLimits;
};

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v && /^[0-9]{1,6}$/.test(v.trim()) ? Number(v) : def;
  return Math.min(max, Math.max(min, n));
};

/** SEMANTIC_EMBEDDINGS_ENABLED (default false); concurrency 1..4; caps per job. */
export function loadEmbeddingsWorkerEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingsWorkerEnv {
  return {
    enabled: env.SEMANTIC_EMBEDDINGS_ENABLED?.trim().toLowerCase() === 'true',
    concurrency: int(env.SEMANTIC_EMBEDDINGS_CONCURRENCY, 1, 1, 4),
    redisUrl: env.REDIS_URL?.trim() || 'redis://localhost:6379',
    limits: {
      maxSources: int(env.SEMANTIC_EMBEDDINGS_MAX_SOURCES, 2000, 1, 10_000),
      batchSize: int(env.SEMANTIC_EMBEDDINGS_BATCH, 32, 1, 32),
    },
  };
}

export type EmbeddingsRegistration =
  | { registered: false; reason: 'disabled' | 'missing_dependencies' }
  | { registered: true; close: () => Promise<void> };

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

/** BullMQ consumer of EMBEDDINGS_QUEUE. Transient provider trouble retries; bad payloads never do. */
export function startEmbeddingsWorker(
  cfg: { redisUrl: string; concurrency: number },
  deps: Parameters<typeof runMeetingEmbeddings>[0],
) {
  const connection = createAppRedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<EmbeddingJobPayload>(
    EMBEDDINGS_QUEUE,
    async (job) => {
      try {
        return await runMeetingEmbeddings(deps, {
          organizationId: job.data.organizationId,
          meetingId: job.data.meetingId,
          ...(job.id ? { jobId: job.id } : {}),
        });
      } catch (err) {
        if (err instanceof EmbeddingRetryableError) throw err;
        if (err instanceof TypeError) throw new UnrecoverableError('invalid embedding job');
        throw err;
      }
    },
    { connection, concurrency: cfg.concurrency },
  );
  return {
    close: async () => {
      await worker.close();
      connection.disconnect();
    },
  };
}

/**
 * Registration for apps/worker main(), same shape as registerSummaryWorker (a `{ registered, close }` job handle), so
 * it drops into the jobs list once the main() rewrite (#333) lands. Not called from main() yet.
 */
export function registerEmbeddingsWorker(opts: {
  env?: EmbeddingsWorkerEnv;
  resolveExecutor?: () => Pick<AIExecutor, 'run'> | undefined;
  repo?: EmbeddingRepository;
  start?: typeof startEmbeddingsWorker;
  logger?: Log;
}): EmbeddingsRegistration {
  const env = opts.env ?? loadEmbeddingsWorkerEnv();
  const log = opts.logger ?? baseLogger;
  if (!env.enabled) return { registered: false, reason: 'disabled' };
  const executor = opts.resolveExecutor?.();
  if (!executor) {
    log.warn({ worker: EMBEDDINGS_QUEUE }, 'embeddings worker enabled but no AI executor');
    return { registered: false, reason: 'missing_dependencies' };
  }
  const { close } = (opts.start ?? startEmbeddingsWorker)(
    { redisUrl: env.redisUrl, concurrency: env.concurrency },
    {
      repo: opts.repo ?? createPrismaEmbeddingRepository(),
      embed: (req) => embedWithExecutor(executor, req),
      log,
      limits: env.limits,
    },
  );
  return { registered: true, close };
}
