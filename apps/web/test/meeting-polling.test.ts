import { describe, expect, it } from 'vitest';
import { MEETING_POLL_MS, meetingPollInterval } from '@/lib/api/queries';

describe('meeting processing-status polling', () => {
  it('polls while recording or processing', () => {
    expect(meetingPollInterval('recording')).toBe(MEETING_POLL_MS);
    expect(meetingPollInterval('processing')).toBe(MEETING_POLL_MS);
  });
  it('stops once the meeting settles or is unknown', () => {
    for (const s of ['scheduled', 'completed', 'failed'] as const)
      expect(meetingPollInterval(s)).toBe(false);
    expect(meetingPollInterval(undefined)).toBe(false);
  });
});
