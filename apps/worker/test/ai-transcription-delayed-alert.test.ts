import { describe, expect, it, vi } from 'vitest';
import {
  createPrismaDelayedAlertStore,
  delayedAlertDedupeKey,
  writeTranscriptionDelayedEvents,
  type DelayedAlertStore,
} from '../src/ai/transcription-delayed-alert.js';
import type { DatabaseTransaction } from '@meetops/database';
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

/** Behaves like the unique (org_id, dedupe_key) index: the first insert per key wins, atomically. */
function memStore(creator: string | null) {
  const events: Array<Parameters<DelayedAlertStore['writeEventOnce']>[0]> = [];
  const keys = new Set<string>();
  const store: DelayedAlertStore = {
    meetingCreator: async () => creator,
    writeEventOnce: async (e) => {
      await Promise.resolve(); // interleave concurrent callers
      if (keys.has(e.dedupeKey)) return false;
      keys.add(e.dedupeKey);
      events.push(e);
      return true;
    },
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

  it('is atomic: concurrent dead-letters for one recording write each event once', async () => {
    const m = memStore(CREATOR);
    const rs = await Promise.all([
      writeTranscriptionDelayedEvents(m.store, letter()),
      writeTranscriptionDelayedEvents(m.store, letter({ jobId: 'j2', chunkIndex: 1 })),
      writeTranscriptionDelayedEvents(m.store, letter({ jobId: 'j3', chunkIndex: 2 })),
    ]);
    expect(rs.flatMap((r) => r.written).sort()).toEqual([
      'meeting.transcription_delayed',
      'meeting.transcription_delayed.owner',
    ]);
    expect(m.events).toHaveLength(2);
  });

  it('dedupe key covers event type, recipient aggregate, recording and UTC day', async () => {
    const m = memStore(CREATOR);
    await writeTranscriptionDelayedEvents(m.store, letter());
    expect(m.events.map((e) => e.dedupeKey)).toEqual([
      delayedAlertDedupeKey('meeting.transcription_delayed', MEET, REC, '2026-11-03'),
      delayedAlertDedupeKey('meeting.transcription_delayed.owner', CREATOR, REC, '2026-11-03'),
    ]);
  });
});

describe('createPrismaDelayedAlertStore', () => {
  it('writes with INSERT ... ON CONFLICT DO NOTHING (createMany skipDuplicates), no JSON lookup', async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn();
    const tx = { outboxEvent: { createMany, findFirst } } as unknown as DatabaseTransaction;
    const store = createPrismaDelayedAlertStore(tx, ORG);
    const e = {
      aggregateType: 'meeting' as const,
      aggregateId: MEET,
      eventType: 'meeting.transcription_delayed',
      payload: { meetingId: MEET },
      dedupeKey: 'k1',
    };
    expect(await store.writeEventOnce(e)).toBe(true);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ organizationId: ORG, ...e }],
      skipDuplicates: true,
    });
    createMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.writeEventOnce(e)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
