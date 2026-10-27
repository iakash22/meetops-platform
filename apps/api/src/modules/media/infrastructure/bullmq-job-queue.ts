import { MEDIA_QUEUE } from '@meetops/contracts';
import { mediaJobId, type MediaJobQueue, type MediaProcessingJob } from '../domain/ports.js';

/** The slice of a BullMQ Queue the producer uses (keeps the adapter unit-testable without Redis). */
export interface MediaQueueProducer {
  readonly name: string;
  add(
    name: string,
    data: MediaProcessingJob,
    opts: { jobId: string; attempts: number; backoff: { type: 'exponential'; delay: number } },
  ): Promise<unknown>;
}

export const MEDIA_JOB_ATTEMPTS = 5;

/**
 * BullMQ producer for MEDIA_QUEUE (replaces InMemoryMediaJobQueue outside tests). Job name = payload kind, and a
 * deterministic jobId so a retried request does not enqueue twice (BullMQ ignores a duplicate id).
 */
export class BullMqMediaJobQueue implements MediaJobQueue {
  constructor(private readonly queue: MediaQueueProducer) {
    if (queue.name !== MEDIA_QUEUE)
      throw new Error(`Media producer must use queue "${MEDIA_QUEUE}"`);
  }

  async enqueue(job: MediaProcessingJob): Promise<void> {
    await this.queue.add(job.kind, job, {
      jobId: mediaJobId(job),
      attempts: MEDIA_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }
}
