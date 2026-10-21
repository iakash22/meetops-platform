import type { Queue } from 'bullmq';
import { MEDIA_JOB_NAME, type MediaProcessingJobPayload } from './types.js';
import { mediaJobId } from './ids.js';

/** Producer helper (API side): one job per recording via deterministic jobId. */
export function enqueueMediaJob(queue: Pick<Queue<MediaProcessingJobPayload>, 'add'>, payload: MediaProcessingJobPayload) {
  return queue.add(MEDIA_JOB_NAME, payload, {
    jobId: mediaJobId(payload.organizationId, payload.recordingId),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 1000
  });
}
