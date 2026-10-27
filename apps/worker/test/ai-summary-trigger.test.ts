import { describe, expect, it } from 'vitest';
import {
  SUMMARY_JOB_NAME,
  SUMMARY_PROMPT_VERSION,
  createQueueSummaryTrigger,
  summaryJobId,
  type SummaryQueueLike,
} from '../src/ai/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';

describe('summary trigger', () => {
  it('dedupes by meeting + revision + prompt version via the job id', async () => {
    const adds: Array<{ name: string; data: unknown; opts: { jobId: string; attempts: number } }> =
      [];
    const ids = new Set<string>();
    const queue: SummaryQueueLike = {
      add: async (name, data, opts) => {
        if (ids.has(opts.jobId)) return; // BullMQ semantics: existing job id is a no-op
        ids.add(opts.jobId);
        adds.push({ name, data, opts });
      },
    };
    const t = createQueueSummaryTrigger(queue);
    await t.transcriptReady({ organizationId: ORG, meetingId: MEET, transcriptRevision: 2 });
    await t.transcriptReady({ organizationId: ORG, meetingId: MEET, transcriptRevision: 2 });
    await t.transcriptReady({ organizationId: ORG, meetingId: MEET, transcriptRevision: 3 });
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatchObject({
      name: SUMMARY_JOB_NAME,
      data: { organizationId: ORG, meetingId: MEET },
      opts: { jobId: `summary__${MEET}__r2__${SUMMARY_PROMPT_VERSION}`, attempts: 3 },
    });
    await createQueueSummaryTrigger(queue, 'meeting-summary@2').transcriptReady({
      organizationId: ORG,
      meetingId: MEET,
      transcriptRevision: 2,
    });
    expect(adds).toHaveLength(3);
  });
  it('job ids never contain ":" (BullMQ restriction)', () => {
    expect(summaryJobId(MEET, 1, 'a:b')).not.toContain(':');
  });
});
