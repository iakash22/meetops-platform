import { describe, expect, it } from 'vitest';
import {
  writeTranscriptionDelayedEvents,
  type DelayedAlertStore,
} from '../src/ai/transcription-delayed-alert.js';
import type { TranscriptionDeadLetter } from '../src/ai/transcription-retry.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const CREATOR = '44444444-4444-4444-8444-000000000001';

const letter = (over: Partial<TranscriptionDeadLetter> = {}): TranscriptionDeadLetter => ({
  organizationId: ORG,
  meetingId: MEET,
  recordingId: REC,
  chunkIndex: 0,
  jobId: 'j1',
  errorCode: 'provider_retryable',
  attemptsMade: 6,
  failedAt: '2026-11-03T12:00:00.000Z',
  ...over,
});

function memStore(creator: string | null) {
  const events: Array<Parameters<DelayedAlertStore['writeEvent']>[0] & { day: string }> = [];
  const store: DelayedAlertStore = {
    meetingCreator: async () => creator,
    alreadyAlerted: async (t, a, r, day) =>
      events.some(
        (e) =>
          e.eventType === t && e.aggregateId === a && e.payload.recordingId === r && e.day === day,
      ),
    writeEvent: async (e) => void events.push({ ...e, day: e.payload.failedAt!.slice(0, 10) }),
  };
  return { store, events };
}

describe('writeTranscriptionDelayedEvents', () => {
  it('writes the admin event and the creator event (ids and codes only)', async () => {
    const m = memStore(CREATOR);
    const r = await writeTranscriptionDelayedEvents(m.store, letter());
    expect(r.written).toEqual([
      'meeting.transcription_delayed',
      'meeting.transcription_delayed.owner',
    ]);
    expect(m.events.map((e) => [e.aggregateType, e.aggregateId])).toEqual([
      ['meeting', MEET],
      ['user', CREATOR],
    ]);
    expect(m.events[0]!.payload).toEqual({
      meetingId: MEET,
      recordingId: REC,
      errorCode: 'provider_retryable',
      failedAt: '2026-11-03T12:00:00.000Z',
    });
  });

  it('does not write again for the same recording on the same day (retries, other chunks)', async () => {
    const m = memStore(CREATOR);
    await writeTranscriptionDelayedEvents(m.store, letter());
    const again = await writeTranscriptionDelayedEvents(
      m.store,
      letter({ jobId: 'j2', chunkIndex: 1 }),
    );
    expect(again.written).toEqual([]);
    expect(m.events).toHaveLength(2);
    const nextDay = await writeTranscriptionDelayedEvents(
      m.store,
      letter({ failedAt: '2026-11-04T00:10:00.000Z' }),
    );
    expect(nextDay.written).toHaveLength(2);
  });

  it('skips the creator event when the meeting has no creator', async () => {
    const m = memStore(null);
    expect((await writeTranscriptionDelayedEvents(m.store, letter())).written).toEqual([
      'meeting.transcription_delayed',
    ]);
  });

  it('never forwards an unexpected error code', async () => {
    const m = memStore(null);
    await writeTranscriptionDelayedEvents(m.store, letter({ errorCode: 'Some Provider Text' }));
    expect(m.events[0]!.payload.errorCode).toBe('provider_unavailable');
  });
});
