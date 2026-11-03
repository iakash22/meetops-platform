import { describe, expect, it } from 'vitest';
import type { NotificationDeliveryJobPayload } from '@meetops/contracts';
import {
  RELAY_EVENT_TYPES,
  TRANSCRIPTION_DELAYED_EVENT,
  TRANSCRIPTION_DELAYED_OWNER_EVENT,
  fanoutEvent,
  type ClaimedOutboxEvent,
  type FanoutStore,
} from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-000000000001';
const ADMIN = '44444444-4444-4444-8444-000000000002';
const MEMBER = '44444444-4444-4444-8444-000000000003';
const VIEWER = '44444444-4444-4444-8444-000000000004';
const roles: Record<string, string> = {
  [OWNER]: 'owner',
  [ADMIN]: 'admin',
  [MEMBER]: 'member',
  [VIEWER]: 'viewer',
};
const payload = {
  meetingId: MEET,
  recordingId: REC,
  errorCode: 'provider_retryable',
  failedAt: '2026-11-03T12:00:00.000Z',
};

const ev = (over: Partial<ClaimedOutboxEvent>): ClaimedOutboxEvent => ({
  id: '66666666-6666-4666-8666-666666666666',
  organizationId: ORG,
  aggregateType: 'meeting',
  aggregateId: MEET,
  eventType: TRANSCRIPTION_DELAYED_EVENT,
  payload,
  attempts: 1,
  ...over,
});

function setup() {
  const rows = new Map<string, { id: string; userId: string; type: string; data: unknown }>();
  const jobs = new Map<string, NotificationDeliveryJobPayload>();
  const store: FanoutStore = {
    recipients: async (_o, rs) =>
      Object.entries(roles)
        .filter(([, r]) => (rs as readonly string[]).includes(r))
        .map(([u]) => u),
    preferences: async () => [],
    createNotification: async (_o, i) => {
      const k = `${i.userId}:${i.dedupeKey}`;
      if (!rows.has(k))
        rows.set(k, { id: `n${rows.size}`, userId: i.userId, type: i.type, data: i.data });
      return { id: rows.get(k)!.id };
    },
  };
  const producer = {
    enqueue: async (p: NotificationDeliveryJobPayload) => void jobs.set(p.deliveryKey, p),
  };
  return { rows, jobs, deps: { store, producer } };
}

describe('meeting.transcription_delayed fan-out', () => {
  it('is relayed', () => {
    expect(RELAY_EVENT_TYPES).toContain(TRANSCRIPTION_DELAYED_EVENT);
    expect(RELAY_EVENT_TYPES).toContain(TRANSCRIPTION_DELAYED_OWNER_EVENT);
  });

  it('notifies org owners and admins only, ids and codes only', async () => {
    const s = setup();
    await fanoutEvent(ev({}), s.deps);
    const rows = [...s.rows.values()];
    expect(rows.map((r) => r.userId).sort()).toEqual([OWNER, ADMIN].sort());
    expect(rows[0]).toMatchObject({
      type: 'meeting.transcription_delayed',
      data: { meetingId: MEET, recordingId: REC, errorCode: 'provider_retryable' },
    });
  });

  it('the owner event notifies only the meeting creator, even a member', async () => {
    const s = setup();
    await fanoutEvent(
      ev({
        eventType: TRANSCRIPTION_DELAYED_OWNER_EVENT,
        aggregateType: 'user',
        aggregateId: MEMBER,
      }),
      s.deps,
    );
    expect([...s.rows.values()].map((r) => r.userId)).toEqual([MEMBER]);
  });

  it('a creator who is also an admin, and replays, get one notification', async () => {
    const s = setup();
    await fanoutEvent(ev({}), s.deps);
    await fanoutEvent(ev({}), s.deps);
    await fanoutEvent(
      ev({
        id: '77777777-7777-4777-8777-777777777777',
        eventType: TRANSCRIPTION_DELAYED_OWNER_EVENT,
        aggregateType: 'user',
        aggregateId: ADMIN,
      }),
      s.deps,
    );
    expect(s.rows.size).toBe(2);
    expect(s.jobs.size).toBe(2 * 3);
  });

  it('a new UTC day notifies again', async () => {
    const s = setup();
    await fanoutEvent(ev({}), s.deps);
    await fanoutEvent(
      ev({ payload: { ...payload, failedAt: '2026-11-04T01:00:00.000Z' } }),
      s.deps,
    );
    expect(s.rows.size).toBe(4);
  });

  it('rejects payloads with free text', async () => {
    const s = setup();
    await expect(
      fanoutEvent(ev({ payload: { ...payload, errorCode: 'Provider said: <secret>' } }), s.deps),
    ).rejects.toThrow();
  });
});
