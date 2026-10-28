import { Queue, type JobsOptions } from 'bullmq';
import { MEDIA_QUEUE } from '@meetops/contracts';
import type { MediaJobQueue, MediaProcessingJob } from '../domain/ports.js';

/** Minimal producer surface (BullMQ Queue#add), injectable for tests. */
export interface MediaQueueProducer {
  add(name: string, data: MediaProcessingJob, opts: JobsOptions): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * Deterministic BullMQ job id per subject (no ':' — BullMQ rejects it in custom ids), so a retried complete() never
 * queues a second job. Same shape as the worker's mediaJobId (`media_{org}_{recordingId}`).
 */
export const mediaProcessingJobId = (j: MediaProcessingJob) =>
  `${j.kind === 'process_upload' ? 'upload' : 'session'}_${j.organizationId}_${j.subjectId}`;

/** Same options as the worker's enqueueMediaJob (apps/worker/src/media/enqueue.ts). */
export const MEDIA_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const satisfies JobsOptions;

/** Durable media job queue: BullMQ on the worker's MEDIA_QUEUE; the worker routes by `kind`. */
export class BullMqMediaJobQueue implements MediaJobQueue {
  constructor(private readonly producer: MediaQueueProducer) {}

  async enqueue(job: MediaProcessingJob): Promise<void> {
    await this.producer.add(job.kind, job, { ...MEDIA_JOB_OPTIONS, jobId: mediaProcessingJobId(job) });
  }

  async close(): Promise<void> {
    await this.producer.close?.();
  }
}

/** BullMQ producer on REDIS_URL (its own connection: BullMQ needs maxRetriesPerRequest: null). */
export function createMediaQueueProducer(redisUrl: string): MediaQueueProducer {
  const queue = new Queue<MediaProcessingJob>(MEDIA_QUEUE, {
    connection: { url: redisUrl, maxRetriesPerRequest: null, lazyConnect: true },
  });
  return {
    add: (name, data, opts) => queue.add(name, data, opts),
    close: () => queue.close(),
  };
}
