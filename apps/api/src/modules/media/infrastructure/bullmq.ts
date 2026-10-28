import { Queue, type JobsOptions } from 'bullmq';
import { MEDIA_QUEUE } from '@meetops/contracts';
import type { MediaJobQueue, MediaProcessingJob } from '../domain/ports.js';

/** Minimal producer surface (BullMQ Queue#add), injectable for tests. */
export interface MediaQueueProducer {
  add: (name: string, data: MediaProcessingJob, opts: JobsOptions) => Promise<unknown>;
  /** Finished-state lookup + removal for requeue (BullMQ Queue#getJob -> Job#getState / Job#remove). */
  removeIfFinished?: (jobId: string) => Promise<boolean>;
  close?: () => Promise<void>;
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

  async requeue(job: MediaProcessingJob): Promise<void> {
    await this.producer.removeIfFinished?.(mediaProcessingJobId(job));
    await this.enqueue(job);
  }

  async close(): Promise<void> {
    await this.producer.close?.();
  }
}

/**
 * BullMQ producer on REDIS_URL (its own connection: BullMQ needs maxRetriesPerRequest: null), created on the first
 * enqueue so building the deps never opens a connection. Connection errors go to `onError` (an unhandled Queue
 * 'error' event would crash the process); enqueue() itself still rejects.
 */
export function createMediaQueueProducer(
  redisUrl: string,
  onError: (err: Error) => void = (err) => process.emitWarning(`media queue: ${err.message}`),
): MediaQueueProducer {
  let queue: Queue<MediaProcessingJob> | undefined;
  const get = () => {
    if (!queue) {
      queue = new Queue<MediaProcessingJob>(MEDIA_QUEUE, {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
      });
      queue.on('error', onError);
    }
    return queue;
  };
  return {
    add: (name, data, opts) => get().add(name, data, opts),
    removeIfFinished: async (jobId) => {
      const job = await get().getJob(jobId);
      if (!job) return false;
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') return false;
      await job.remove();
      return true;
    },
    close: async () => {
      await queue?.close();
    },
  };
}
