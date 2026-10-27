import { QUEUE_NAMES } from '@meetops/contracts';
import { SUMMARY_PROMPT_VERSION, type MeetingSummaryInput } from './meeting-summary.js';

export const SUMMARY_JOB_NAME = 'summarize_meeting';

export type SummaryTriggerEvent = {
  organizationId: string;
  meetingId: string;
  transcriptRevision: number;
};

/** Called when a transcription job has a complete (`ready`) merged transcript revision. Must be idempotent. */
export interface SummaryTrigger {
  transcriptReady(event: SummaryTriggerEvent): Promise<void>;
}

/** Minimal BullMQ `Queue` surface used here (keeps tests free of Redis). */
export type SummaryQueueLike = {
  add(
    name: string,
    data: MeetingSummaryInput,
    opts: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: { age: number };
      removeOnFail: { age: number };
    },
  ): Promise<unknown>;
};

/**
 * Dedupe key: meetingId + transcript revision + prompt version. BullMQ ignores `add` for an existing job id, so
 * re-running a transcription job (retry, duplicate chunk, crash after write) never enqueues a second summary.
 * BullMQ custom ids must not contain ':'.
 */
export function summaryJobId(
  meetingId: string,
  transcriptRevision: number,
  promptVersion = SUMMARY_PROMPT_VERSION,
): string {
  return `summary__${meetingId}__r${transcriptRevision}__${promptVersion.replace(/:/g, '_')}`;
}

export const SUMMARY_JOB_ATTEMPTS = 3;
const DAY_S = 24 * 3600;

export function createQueueSummaryTrigger(
  queue: SummaryQueueLike,
  promptVersion = SUMMARY_PROMPT_VERSION,
): SummaryTrigger {
  return {
    async transcriptReady({ organizationId, meetingId, transcriptRevision }) {
      await queue.add(
        SUMMARY_JOB_NAME,
        { organizationId, meetingId },
        {
          jobId: summaryJobId(meetingId, transcriptRevision, promptVersion),
          attempts: SUMMARY_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: 30_000 },
          // Keep completed ids for a week so late duplicates are still deduped; failed ones for 30 days.
          removeOnComplete: { age: 7 * DAY_S },
          removeOnFail: { age: 30 * DAY_S },
        },
      );
    },
  };
}

export const SUMMARY_QUEUE = QUEUE_NAMES.ai;
