import { Queue, Worker, QueueOptions, WorkerOptions, type Processor } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import { loadConfig, redisTlsOptions } from '@meetops/config';
import { logger as baseLogger } from '@meetops/logger';

export type { Queue, Worker, QueueOptions, WorkerOptions };

/**
 * Redis client for queues (BullMQ needs maxRetriesPerRequest: null). `overrides` lets a non-queue caller, such as
 * a lease, opt into fail-fast behaviour (maxRetriesPerRequest, commandTimeout) on its own connection.
 */
export function createRedisClient(overrides: RedisOptions = {}) {
  const config = loadConfig();
  const url = config.REDIS_URL;
  const { tls } = redisTlsOptions(url);
  const overrideTls = overrides.tls && typeof overrides.tls === 'object' ? overrides.tls : {};
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    ...overrides,
    ...(tls
      ? { tls: { ...overrideTls, servername: overrideTls.servername ?? tls.servername } }
      : {}),
  });
  return client;
}

export function createQueue<T = unknown>(
  name: string,
  options: Omit<QueueOptions, 'connection'> = {},
) {
  const connection = createRedisClient();
  const queue = new Queue<T>(name, { connection, ...options });
  return queue;
}

export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R, string>,
  options: Omit<WorkerOptions, 'connection'> = {},
) {
  const connection = createRedisClient();
  const worker = new Worker<T, R>(name, processor, { connection, ...options });
  const logger = baseLogger.child({ worker: name });
  worker.on('completed', (job) => logger.debug({ jobId: job.id }, 'job completed'));
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err: err?.message }, 'job failed'),
  );
  return worker;
}
