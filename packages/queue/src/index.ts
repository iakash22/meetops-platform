import { Queue, Worker, QueueOptions, WorkerOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '@meetops/config';
import { logger as baseLogger } from '@meetops/logger';

export type { Queue, Worker, QueueOptions, WorkerOptions };

export function createRedisClient() {
  const config = loadConfig();
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true
  });
  return client;
}

export function createQueue<T = unknown>(
  name: string,
  options: Omit<QueueOptions, 'connection'> = {}
) {
  const connection = createRedisClient();
  const queue = new Queue<T>(name, { connection, ...options });
  return queue;
}

export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R, string>,
  options: Omit<WorkerOptions, 'connection'> = {}
) {
  const connection = createRedisClient();
  const worker = new Worker<T, R>(name, processor, { connection, ...options });
  const logger = baseLogger.child({ worker: name });
  worker.on('completed', (job) => logger.debug({ jobId: job.id }, 'job completed'));
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err: err?.message }, 'job failed')
  );
  return worker;
}
