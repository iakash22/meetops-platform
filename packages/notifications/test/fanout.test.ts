import { describe, expect, it, vi } from 'vitest';
import { GENERIC_PUSH_TITLE, type NotificationDeliveryJobPayload } from '@meetops/contracts';
import {
  MAX_RELAY_ATTEMPTS,
  OutboxPayloadError,
  PermanentNotificationError,
  TransientNotificationError,
  channelEnabled,
  createExpoPushSender,
  createNotificationDeliveryHandler,
  createNotificationDeliveryProcessor,
  createWebPushSender,
  fanoutEvent,
  relayBackoffMs,
  relayOutboxOnce,
  RELAY_EVENT_TYPES,
  type ClaimedOutboxEvent,
  type DeliveryDevice,
  type DeliveryStore,
  type FanoutPreference,
  type FanoutStore,
  type PushSender,
} from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REPORT = '33333333-3333-4333-8333-333333333333';
const U = (i: number) => `44444444-4444-4444-8444-00000000000${i}`;
const N = (i: number) => `55555555-5555-4555-8555-00000000000${i}`;
const logger = { info: () => {}, warn: () => {} };

const ev = (over: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent => ({
  id: '66666666-6666-4666-8666-666666666666',
  organizationId: ORG,
  aggregateType: 'meeting',
  aggregateId: MEET,
  eventType: 'extracted_tasks.pending_review',
  payload: {
    kind: 'tasks.ready_for_review',
    meetingId: MEET,
    reportId: REPORT,
    aiRunId: REPORT,
    count: 2,
  },
  attempts: 1,
  ...over,
});

function memStore(roles: Record<string, string>, prefs: Record<string, FanoutPreference[]> = {}) {
  const rows = new Map<string, { id: string; userId: string; type: string; data: unknown }>();
  const store: FanoutStore & { rows: typeof rows; calls: string[] } = {
    rows,
    calls: [],
    async recipients(org, rs) {
      store.calls.push(`recipients:${org}`);
      return Object.entries(roles)
        .filter(([, r]) => (rs as readonly string[]).includes(r))
        .map(([u]) => u);
    },
    async preferences(_o, u) {
      return prefs[u] ?? [];
    },
    async createNotification(_o, i) {
      const k = `${i.userId}:${i.dedupeKey}`;
      if (!rows.has(k))
        rows.set(k, { id: N(rows.size), userId: i.userId, type: i.type, data: i.data });
      return { id: rows.get(k)!.id };
    },
  };
  return store;
}
function memProducer() {
  const jobs = new Map<string, NotificationDeliveryJobPayload>();
  return {
    jobs,
    enqueue: async (p: NotificationDeliveryJobPayload) => void jobs.set(p.deliveryKey, p),
  };
}

describe('preferences', () => {
  it('exact > wildcard > default (email opt-in)', () => {
    const p: FanoutPreference[] = [
      { type: '*', channel: 'web_push', enabled: false },
      { type: 'tasks.ready_for_review', channel: 'web_push', enabled: true },
      { type: '*', channel: 'in_app', enabled: false },
    ];
    expect(channelEnabled(p, 'tasks.ready_for_review', 'web_push')).toBe(true);
    expect(channelEnabled(p, 'other', 'web_push')).toBe(false);
    expect(channelEnabled(p, 'x', 'in_app')).toBe(false);
    expect(channelEnabled([], 'x', 'mobile_push')).toBe(true);
    expect(channelEnabled([], 'x', 'email')).toBe(false);
  });
});

describe('fanoutEvent', () => {
  it('tasks.ready_for_review: reviewers only (no viewers), per-channel jobs, prefs respected', async () => {
    const store = memStore(
      { [U(1)]: 'owner', [U(2)]: 'member', [U(3)]: 'viewer', [U(4)]: 'admin' },
      {
        [U(2)]: [
          { type: '*', channel: 'web_push', enabled: false },
          { type: '*', channel: 'mobile_push', enabled: false },
        ],
        [U(4)]: [
          { type: 'tasks.ready_for_review', channel: 'in_app', enabled: false },
          { type: '*', channel: 'web_push', enabled: false },
          { type: '*', channel: 'mobile_push', enabled: false },
        ],
      },
    );
    const producer = memProducer();
    const r = await fanoutEvent(ev(), { store, producer });
    expect(r).toEqual({ ignored: false, notifications: 2, jobs: 4 });
    const users = [...store.rows.values()].map((x) => x.userId).sort();
    expect(users).toEqual([U(1), U(2)]);
    expect([...store.rows.values()][0]).toMatchObject({
      type: 'tasks.ready_for_review',
      data: { meetingId: MEET, reportId: REPORT, count: 2 },
    });
    const channels = [...producer.jobs.values()].map((j) => `${j.userId}:${j.channel}`).sort();
    expect(channels).toEqual([
      `${U(1)}:in_app`,
      `${U(1)}:mobile_push`,
      `${U(1)}:web_push`,
      `${U(2)}:in_app`,
    ]);
    for (const j of producer.jobs.values()) {
      expect(j).toMatchObject({ jobVersion: 1, kind: 'deliver_notification', organizationId: ORG });
      expect(j.deliveryKey).toBe(`${j.notificationId}:${j.channel}`);
    }
  });
  it('is idempotent on replay (same rows, same delivery keys)', async () => {
    const store = memStore({ [U(1)]: 'owner' });
    const producer = memProducer();
    await fanoutEvent(ev(), { store, producer });
    await fanoutEvent(ev(), { store, producer });
    expect(store.rows.size).toBe(1);
    expect(producer.jobs.size).toBe(3);
  });
  it('meeting.summary_ready goes to every member, in-app only', async () => {
    const store = memStore({ [U(1)]: 'owner', [U(3)]: 'viewer' });
    const producer = memProducer();
    const r = await fanoutEvent(
      ev({ eventType: 'meeting.summary_ready', payload: { meetingId: MEET, reportId: REPORT } }),
      { store, producer },
    );
    expect(r).toEqual({ ignored: false, notifications: 2, jobs: 2 });
    expect([...producer.jobs.values()].every((j) => j.channel === 'in_app')).toBe(true);
  });
  it('accepts the exact payload the #272 summary worker writes (ids/counts only)', async () => {
    const r = await fanoutEvent(
      ev({
        eventType: 'meeting.summary_ready',
        payload: {
          meetingId: MEET,
          reportId: REPORT,
          transcriptRevision: 2,
          tasksPendingReview: 3,
        },
      }),
      { store: memStore({ [U(1)]: 'owner' }), producer: memProducer() },
    );
    expect(r).toEqual({ ignored: false, notifications: 1, jobs: 1 });
    await expect(
      fanoutEvent(
        ev({
          eventType: 'meeting.summary_ready',
          payload: { meetingId: MEET, reportId: REPORT, tasksPendingReview: -1 },
        }),
        { store: memStore({ [U(1)]: 'owner' }), producer: memProducer() },
      ),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
  });
  it('unknown event types are ignored; bad payloads (incl. extra PII-ish keys or bad ids) throw', async () => {
    const store = memStore({ [U(1)]: 'owner' });
    expect(
      await fanoutEvent(ev({ eventType: 'meeting.updated' }), { store, producer: memProducer() }),
    ).toEqual({ ignored: true });
    expect(store.calls).toEqual([]);
    await expect(
      fanoutEvent(ev({ payload: { meetingId: 'x', reportId: REPORT, count: 1 } }), {
        store,
        producer: memProducer(),
      }),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
    await expect(
      fanoutEvent(ev({ payload: { meetingId: MEET, reportId: REPORT, count: 0 } }), {
        store,
        producer: memProducer(),
      }),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
  });
});

describe('relayOutboxOnce', () => {
  function src(events: ClaimedOutboxEvent[]) {
    const done: Array<[string, unknown]> = [];
    return {
      done,
      claim: vi.fn(async () => events),
      complete: async (id: string, o: unknown) => void done.push([id, o]),
    };
  }
  it('claims only handled kinds and never publishes an unknown kind (released unpublished)', async () => {
    const s = src([
      ev(),
      ev({ id: '77777777-7777-4777-8777-777777777777', eventType: 'some.other_consumer_event' }),
    ]);
    const r = await relayOutboxOnce({
      source: s,
      store: memStore({ [U(1)]: 'owner' }),
      producer: memProducer(),
      logger,
      limit: 10,
    });
    expect(r).toEqual({ claimed: 2, published: 1, retried: 0, failed: 0, skipped: 1 });
    expect(s.claim).toHaveBeenCalledWith(10, RELAY_EVENT_TYPES);
    expect([...RELAY_EVENT_TYPES].sort()).toEqual([
      'auth.new_location_signin',
      'extracted_tasks.pending_review',
      'meeting.summary_ready',
      'meeting.transcription_delayed',
      'meeting.transcription_delayed.owner',
    ]);
    expect(s.done[0]![1]).toEqual({ published: true });
    expect(s.done[1]![1]).toMatchObject({ published: false, error: 'unhandled_event_type' });
    expect((s.done[1]![1] as { retryAt?: Date }).retryAt).toBeInstanceOf(Date);
  });
  it('retries transient errors with bounded backoff, fails permanently after MAX or on a bad payload', async () => {
    const store = memStore({ [U(1)]: 'owner' });
    store.recipients = async () => {
      throw new Error('db down');
    };
    const s = src([
      ev({ attempts: 2 }),
      ev({ id: '88888888-8888-4888-8888-888888888888', attempts: MAX_RELAY_ATTEMPTS }),
    ]);
    const r = await relayOutboxOnce({
      source: s,
      store,
      producer: memProducer(),
      logger,
      now: () => 0,
    });
    expect(r).toEqual({ claimed: 2, published: 0, retried: 1, failed: 1, skipped: 0 });
    expect(s.done[0]![1]).toEqual({ published: false, error: 'Error', retryAt: new Date(60_000) });
    expect(s.done[1]![1]).toEqual({ published: false, error: 'Error' });
    const bad = src([ev({ payload: { nope: 1 } })]);
    await relayOutboxOnce({ source: bad, store: memStore({}), producer: memProducer(), logger });
    expect(bad.done[0]![1]).toEqual({ published: false, error: 'OutboxPayloadError' });
    expect(relayBackoffMs(1)).toBe(30_000);
    expect(relayBackoffMs(99)).toBe(3_600_000);
  });
});

function deliveryStore(over: Partial<DeliveryStore> = {}) {
  const attempts: unknown[] = [];
  const deleted: string[] = [];
  const devices: DeliveryDevice[] = [
    {
      id: 'd-web',
      platform: 'web',
      token: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'p', auth: 'a' },
      }),
    },
    { id: 'd-ios', platform: 'ios', token: 'ExponentPushToken[abcdefghijklmnop]' },
  ];
  const store: DeliveryStore = {
    isActiveMember: async () => true,
    preferences: async () => [],
    findNotification: async (_o, _u, id) => ({
      id,
      type: 'tasks.ready_for_review',
      createdAt: new Date(0),
    }),
    activeDevices: async () => devices,
    deleteDevice: async (_o, _u, id) => void deleted.push(id),
    recordAttempt: async (_o, a) => void attempts.push(a),
    ...over,
  };
  return { store, attempts, deleted };
}
const job = (channel: NotificationDeliveryJobPayload['channel'], attemptsMade = 0) => ({
  id: 'j',
  attemptsMade,
  data: {
    jobVersion: 1 as const,
    kind: 'deliver_notification' as const,
    organizationId: ORG,
    userId: U(1),
    notificationId: N(1),
    channel,
    deliveryKey: `${N(1)}:${channel}`,
  },
});
const sender = (
  channel: PushSender['channel'],
  results: Array<Awaited<ReturnType<PushSender['send']>>>,
): PushSender & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    channel,
    sent,
    send: async (t, p) => (sent.push({ t, p }), results.shift() ?? { status: 'sent' }),
  };
};

describe('delivery handler (mocked senders)', () => {
  it('in_app emits ids-only notification:new and records sent', async () => {
    const { store, attempts } = deliveryStore();
    const inApp = { notificationNew: vi.fn() };
    const proc = createNotificationDeliveryProcessor(
      createNotificationDeliveryHandler({ store, inApp, now: () => new Date(5) }),
    );
    expect(await proc(job('in_app'))).toEqual({ status: 'sent' });
    expect(inApp.notificationNew).toHaveBeenCalledWith(U(1), {
      organizationId: ORG,
      notificationId: N(1),
      kind: 'tasks.ready_for_review',
      at: new Date(5).toISOString(),
    });
    expect(attempts).toEqual([
      expect.objectContaining({ status: 'sent', attempt: 1, channel: 'in_app' }),
    ]);
  });
  it('push sends the generic payload to matching platforms only', async () => {
    const { store } = deliveryStore();
    const web = sender('web_push', [{ status: 'sent', providerMessageId: 'm1' }]);
    const mob = sender('mobile_push', []);
    const h = createNotificationDeliveryHandler({ store, webPush: web, mobilePush: mob });
    expect(await createNotificationDeliveryProcessor(h)(job('web_push'))).toEqual({
      status: 'sent',
      providerMessageId: 'm1',
    });
    expect(web.sent).toHaveLength(1);
    expect(mob.sent).toHaveLength(0);
    expect((web.sent[0] as { p: { title: string; data: unknown } }).p).toEqual({
      title: GENERIC_PUSH_TITLE,
      body: expect.any(String),
      data: { notificationId: N(1) },
    });
  });
  it('gone devices are deleted; transient errors throw for a bounded BullMQ retry and are recorded', async () => {
    const a = deliveryStore();
    const h1 = createNotificationDeliveryHandler({
      store: a.store,
      mobilePush: sender('mobile_push', [{ status: 'gone' }]),
    });
    expect(await createNotificationDeliveryProcessor(h1)(job('mobile_push'))).toEqual({
      status: 'skipped',
    });
    expect(a.deleted).toEqual(['d-ios']);
    const b = deliveryStore();
    const h2 = createNotificationDeliveryHandler({
      store: b.store,
      mobilePush: sender('mobile_push', [{ status: 'transient', code: 'expo_503' }]),
    });
    await expect(
      createNotificationDeliveryProcessor(h2)(job('mobile_push', 2)),
    ).rejects.toBeInstanceOf(TransientNotificationError);
    expect(b.attempts).toEqual([
      expect.objectContaining({
        status: 'failed',
        attempt: 3,
        errorCode: 'TransientNotificationError',
      }),
    ]);
  });
  it('re-checks membership (permanent), notification ownership and preferences at send time', async () => {
    const gone = deliveryStore({ isActiveMember: async () => false });
    await expect(
      createNotificationDeliveryProcessor(createNotificationDeliveryHandler({ store: gone.store }))(
        job('in_app'),
      ),
    ).rejects.toBeInstanceOf(PermanentNotificationError);
    const missing = deliveryStore({ findNotification: async () => undefined });
    await expect(
      createNotificationDeliveryProcessor(
        createNotificationDeliveryHandler({ store: missing.store }),
      )(job('in_app')),
    ).rejects.toBeInstanceOf(PermanentNotificationError);
    const off = deliveryStore({
      preferences: async () => [{ type: '*', channel: 'web_push', enabled: false }],
    });
    const web = sender('web_push', []);
    expect(
      await createNotificationDeliveryProcessor(
        createNotificationDeliveryHandler({ store: off.store, webPush: web }),
      )(job('web_push')),
    ).toEqual({ status: 'skipped' });
    expect(web.sent).toEqual([]);
  });
  it('unconfigured channel is skipped; no fallback to another sender', async () => {
    const { store } = deliveryStore();
    const mob = sender('mobile_push', []);
    expect(
      await createNotificationDeliveryProcessor(
        createNotificationDeliveryHandler({ store, mobilePush: mob }),
      )(job('web_push')),
    ).toEqual({ status: 'skipped' });
    expect(
      await createNotificationDeliveryProcessor(
        createNotificationDeliveryHandler({ store, mobilePush: mob }),
      )(job('email')),
    ).toEqual({ status: 'skipped' });
    expect(mob.sent).toEqual([]);
  });
});

describe('Expo sender', () => {
  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const payload = { title: 't', body: 'b', data: { notificationId: N(1) } };
  it('posts to the fixed Expo URL with redirects refused', async () => {
    const f = vi.fn(async () => ok({ data: [{ status: 'ok', id: 'tk1' }] }));
    const r = await createExpoPushSender({ fetch: f }).send(
      'ExponentPushToken[abcdefghijklmnop]',
      payload,
    );
    expect(r).toEqual({ status: 'sent', providerMessageId: 'tk1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual([
      { to: 'ExponentPushToken[abcdefghijklmnop]', ...payload },
    ]);
  });
  it('maps tickets/status codes; never calls Expo with an invalid token', async () => {
    const f = vi.fn(async () =>
      ok({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
    );
    const s = createExpoPushSender({ fetch: f });
    expect(await s.send('ExponentPushToken[abcdefghijklmnop]', payload)).toEqual({
      status: 'gone',
    });
    expect(await s.send('https://evil.example', payload)).toEqual({
      status: 'rejected',
      code: 'invalid_token',
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(
      await createExpoPushSender({ fetch: async () => ok({}, 503) }).send(
        'ExponentPushToken[abcdefghijklmnop]',
        payload,
      ),
    ).toEqual({ status: 'transient', code: 'expo_503' });
    expect(
      await createExpoPushSender({ fetch: async () => new Response(null, { status: 302 }) }).send(
        'ExponentPushToken[abcdefghijklmnop]',
        payload,
      ),
    ).toEqual({ status: 'transient', code: 'expo_redirect_refused' });
    expect(
      await createExpoPushSender({
        fetch: async () => {
          throw new Error('x');
        },
      }).send('ExponentPushToken[abcdefghijklmnop]', payload),
    ).toEqual({ status: 'transient', code: 'expo_network' });
  });
});

describe('Web Push sender', () => {
  const payload = { title: 't', body: 'b', data: { notificationId: N(1) } };
  const sub = (endpoint: string) => JSON.stringify({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
  const publicDns = async () => [{ address: '142.250.1.1', family: 4 as const }];
  it('vets the endpoint (allowlist + SSRF/DNS) and pins the address before the transport', async () => {
    const transport = {
      send: vi.fn<
        (
          t: { pinnedAddress: string },
          p: string,
        ) => Promise<{ statusCode: number; messageId: string }>
      >(async () => ({ statusCode: 201, messageId: 'w1' })),
    };
    const s = createWebPushSender({ transport, lookup: publicDns });
    expect(await s.send(sub('https://fcm.googleapis.com/fcm/send/abc'), payload)).toEqual({
      status: 'sent',
      providerMessageId: 'w1',
    });
    expect(transport.send.mock.calls[0]![0]).toMatchObject({ pinnedAddress: '142.250.1.1' });
  });
  it('rejects hostile endpoints and private DNS answers without calling the transport', async () => {
    const transport = { send: vi.fn(async () => ({ statusCode: 201 })) };
    expect(
      await createWebPushSender({ transport, lookup: publicDns }).send(
        sub('https://evil.example/x'),
        payload,
      ),
    ).toMatchObject({ status: 'rejected' });
    const privateDns = async () => [{ address: '10.0.0.5', family: 4 as const }];
    expect(
      await createWebPushSender({ transport, lookup: privateDns }).send(
        sub('https://fcm.googleapis.com/fcm/send/abc'),
        payload,
      ),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await createWebPushSender({ transport, lookup: publicDns }).send('not json', payload),
    ).toMatchObject({ status: 'rejected' });
    expect(transport.send).not.toHaveBeenCalled();
  });
  it('410 = gone, 429 = transient', async () => {
    const mk = (statusCode: number) =>
      createWebPushSender({ transport: { send: async () => ({ statusCode }) }, lookup: publicDns });
    expect(await mk(410).send(sub('https://fcm.googleapis.com/fcm/send/abc'), payload)).toEqual({
      status: 'gone',
    });
    expect(await mk(429).send(sub('https://fcm.googleapis.com/fcm/send/abc'), payload)).toEqual({
      status: 'transient',
      code: 'webpush_429',
    });
  });
});
