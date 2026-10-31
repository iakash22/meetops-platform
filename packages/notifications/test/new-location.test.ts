import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AuthNewLocationSigninNotificationPayload,
  type NotificationDeliveryJobPayload,
} from '@meetops/contracts';
import {
  NEW_LOCATION_EMAIL_SUBJECT,
  PermanentNotificationError,
  RELAY_EVENT_TYPES,
  TransientNotificationError,
  channelDefaultsForKind,
  createNewLocationEmailSender,
  createNotificationDeliveryHandler,
  createNotificationDeliveryProcessor,
  fanoutEvent,
  renderNewLocationEmail,
  type ClaimedOutboxEvent,
  type DeliveryStore,
  type EmailService,
  type FanoutPreference,
  type FanoutStore,
} from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-000000000001';
const OTHER = '44444444-4444-4444-8444-000000000002';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NID = '55555555-5555-4555-8555-000000000001';
const WEB = 'https://app.example.com';

const ev = (payload: Record<string, unknown> = {}, over: Partial<ClaimedOutboxEvent> = {}) =>
  ({
    id: '66666666-6666-4666-8666-666666666666',
    organizationId: ORG,
    aggregateType: 'user',
    aggregateId: USER,
    eventType: 'auth.new_location_signin',
    payload: {
      sessionId: SESSION,
      city: 'Linköping',
      region: 'Östergötland County',
      country: 'Sweden',
      countryCode: 'SE',
      reason: 'new_country',
      ...payload,
    },
    attempts: 1,
    ...over,
  }) satisfies ClaimedOutboxEvent;

function store(roles: Record<string, string>, prefs: FanoutPreference[] = []) {
  const rows = new Map<
    string,
    { id: string; userId: string; type: string; data: Record<string, unknown> }
  >();
  const s: FanoutStore & { rows: typeof rows } = {
    rows,
    recipients: async (_o, rs) =>
      Object.entries(roles)
        .filter(([, r]) => (rs as readonly string[]).includes(r))
        .map(([u]) => u),
    preferences: async () => prefs,
    createNotification: async (_o, i) => {
      const k = `${i.userId}:${i.dedupeKey}`;
      if (!rows.has(k)) rows.set(k, { id: NID, userId: i.userId, type: i.type, data: i.data });
      return { id: rows.get(k)!.id };
    },
  };
  return s;
}
const producer = () => {
  const jobs: NotificationDeliveryJobPayload[] = [];
  return { jobs, enqueue: async (p: NotificationDeliveryJobPayload) => void jobs.push(p) };
};

describe('fan-out of auth.new_location_signin (ADR-014)', () => {
  it('is claimed by the relay', () => {
    expect(RELAY_EVENT_TYPES).toContain('auth.new_location_signin');
  });
  it('notifies only the aggregate user, in_app + email (email on by default), maps city/country to geoCity/geoCountry', async () => {
    const st = store({ [USER]: 'member', [OTHER]: 'owner' });
    const pr = producer();
    expect(await fanoutEvent(ev(), { store: st, producer: pr })).toEqual({
      ignored: false,
      notifications: 1,
      jobs: 2,
    });
    const [row] = [...st.rows.values()];
    expect(row).toMatchObject({ userId: USER, type: 'auth.new_location_signin' });
    expect(row!.data).toEqual({
      sessionId: SESSION,
      reason: 'new_country',
      geoCity: 'Linköping',
      geoCountry: 'Sweden',
    });
    expect(Value.Check(AuthNewLocationSigninNotificationPayload, row!.data)).toBe(true);
    expect(pr.jobs.map((j) => j.channel).sort()).toEqual(['email', 'in_app']);
    expect(pr.jobs.every((j) => j.userId === USER)).toBe(true);
  });
  it('omits unknown geo keys (optional, never null)', async () => {
    const st = store({ [USER]: 'viewer' });
    await fanoutEvent(ev({ city: null, region: null }), { store: st, producer: producer() });
    const [row] = [...st.rows.values()];
    expect(row!.data).toEqual({ sessionId: SESSION, reason: 'new_country', geoCountry: 'Sweden' });
    expect(Value.Check(AuthNewLocationSigninNotificationPayload, row!.data)).toBe(true);
  });
  it('dedupes per user + location + day (same event twice: one row)', async () => {
    const st = store({ [USER]: 'member' });
    await fanoutEvent(ev(), { store: st, producer: producer() });
    await fanoutEvent(ev({}, { id: '77777777-7777-4777-8777-777777777777' }), {
      store: st,
      producer: producer(),
    });
    expect(st.rows.size).toBe(1);
  });
  it('dedupe key is normalized: case and NFD variants of the same place share one row (#292 L-2)', async () => {
    const st = store({ [USER]: 'member' });
    await fanoutEvent(ev(), { store: st, producer: producer() });
    await fanoutEvent(
      ev(
        { region: 'Östergötland County'.normalize('NFD') },
        { id: '77777777-7777-4777-8777-777777777771' },
      ),
      { store: st, producer: producer() },
    );
    await fanoutEvent(
      ev({ region: 'östergötland county' }, { id: '77777777-7777-4777-8777-777777777772' }),
      { store: st, producer: producer() },
    );
    expect(st.rows.size).toBe(1);
  });
  it('non-member aggregate user or non-user aggregate: nobody is notified', async () => {
    const st = store({ [OTHER]: 'owner' });
    expect(await fanoutEvent(ev(), { store: st, producer: producer() })).toMatchObject({
      notifications: 0,
    });
    const st2 = store({ [USER]: 'owner' });
    expect(
      await fanoutEvent(ev({}, { aggregateType: 'meeting' }), { store: st2, producer: producer() }),
    ).toMatchObject({ notifications: 0 });
  });
  it('payload strictness: an extra ip key or an IP-like city is rejected as a bad payload', async () => {
    const st = store({ [USER]: 'member' });
    await expect(
      fanoutEvent(ev({ ip: '89.160.20.112' }), { store: st, producer: producer() }),
    ).rejects.toThrow('outbox payload');
    await expect(
      fanoutEvent(ev({ city: '89.160.20.112' }), { store: st, producer: producer() }),
    ).rejects.toThrow('outbox payload');
    await expect(
      fanoutEvent(ev({ city: 'Evil\r\nBcc: x' }), { store: st, producer: producer() }),
    ).rejects.toThrow('outbox payload');
  });
  it('user preference can turn the email off', async () => {
    const st = store({ [USER]: 'member' }, [
      { type: 'auth.new_location_signin', channel: 'email', enabled: false },
    ]);
    const pr = producer();
    await fanoutEvent(ev(), { store: st, producer: pr });
    expect(pr.jobs.map((j) => j.channel)).toEqual(['in_app']);
    expect(channelDefaultsForKind('auth.new_location_signin')).toEqual({ email: true });
    expect(channelDefaultsForKind('meeting.summary_ready')).toEqual({});
  });
});

describe('new-location email', () => {
  it('escapes geo text in HTML, keeps the subject location-free, links to the signed-in sessions page only', () => {
    const m = renderNewLocationEmail({
      webBaseUrl: WEB,
      geoCity: `St. John's`,
      geoCountry: 'Trinidad & Tobago',
      reason: 'new_country',
    });
    expect(m.subject).toBe(NEW_LOCATION_EMAIL_SUBJECT);
    expect(m.html).toContain('St. John&#39;s, Trinidad &amp; Tobago');
    expect(m.html).not.toContain(`John's`);
    expect(m.html).toContain('href="https://app.example.com/settings/sessions"');
    expect(m.text).toContain('https://app.example.com/settings/sessions');
    // No one-click token, no session id in the link.
    expect(m.html + m.text).not.toMatch(/[?&](token|session|sid)=/i);
    expect(m.html + m.text).not.toContain(SESSION);
    expect(m.text).toContain('DB-IP');
  });
  it('hostile text (if upstream validation regressed) is escaped / flattened', () => {
    const m = renderNewLocationEmail({
      webBaseUrl: WEB,
      geoCity: '<script>x</script>',
      geoCountry: 'A\r\nBcc: evil@example.com',
      reason: 'new_region',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.text).not.toMatch(/\r|\nBcc:/);
    expect(m.subject).not.toContain('Bcc');
  });
  it('refuses a non-https base URL', () => {
    expect(() =>
      renderNewLocationEmail({
        webBaseUrl: 'http://app.example.com',
        geoCity: null,
        geoCountry: null,
        reason: 'new_country',
      }),
    ).toThrow();
  });
});

function emailService(fail = false) {
  const sent: Array<{ to: unknown; subject: string; html?: string; text?: string }> = [];
  const svc: EmailService & { sent: typeof sent } = {
    provider: 'test',
    sent,
    send: async (m) => {
      if (fail) throw new Error('smtp said no to user@example.com');
      sent.push(m);
      return { messageId: 'mid-1', accepted: [], rejected: [], provider: 'test' };
    },
    verify: async () => true,
  };
  return svc;
}

describe('email channel delivery', () => {
  const data = {
    sessionId: SESSION,
    reason: 'new_country',
    geoCity: 'London',
    geoCountry: 'United Kingdom',
  };
  const dstore = (over: Partial<DeliveryStore> = {}) => {
    const attempts: unknown[] = [];
    const s: DeliveryStore = {
      isActiveMember: async () => true,
      preferences: async () => [],
      findNotification: async (_o, _u, id) => ({
        id,
        type: 'auth.new_location_signin',
        createdAt: new Date(0),
        data,
      }),
      activeDevices: async () => [],
      deleteDevice: async () => {},
      recordAttempt: async (_o, a) => void attempts.push(a),
      ...over,
    };
    return { s, attempts };
  };
  const job = {
    id: 'j',
    attemptsMade: 0,
    data: {
      jobVersion: 1 as const,
      kind: 'deliver_notification' as const,
      organizationId: ORG,
      userId: USER,
      notificationId: NID,
      channel: 'email' as const,
      deliveryKey: `${NID}:email`,
    },
  };
  const sender = (svc: EmailService, userEmail = vi.fn(async () => 'user@example.com')) =>
    createNewLocationEmailSender({ email: svc, userEmail, webBaseUrl: WEB });

  it('sends to the server-resolved address with the default-on email channel', async () => {
    const svc = emailService();
    const userEmail = vi.fn(async () => 'user@example.com');
    const { s, attempts } = dstore();
    const proc = createNotificationDeliveryProcessor(
      createNotificationDeliveryHandler({ store: s, email: sender(svc, userEmail) }),
    );
    expect(await proc(job)).toEqual({ status: 'sent', providerMessageId: 'mid-1' });
    expect(userEmail).toHaveBeenCalledWith(USER);
    expect(svc.sent[0]).toMatchObject({
      to: 'user@example.com',
      subject: NEW_LOCATION_EMAIL_SUBJECT,
    });
    expect(svc.sent[0]!.html).toContain('London, United Kingdom');
    expect(attempts).toEqual([expect.objectContaining({ channel: 'email', status: 'sent' })]);
  });
  it('no email sender configured, or the user opted out: skipped', async () => {
    const { s } = dstore();
    const h = createNotificationDeliveryHandler({ store: s });
    expect(await createNotificationDeliveryProcessor(h)(job)).toEqual({ status: 'skipped' });
    const { s: s2 } = dstore({
      preferences: async () => [
        { type: 'auth.new_location_signin', channel: 'email', enabled: false },
      ],
    });
    const svc = emailService();
    const h2 = createNotificationDeliveryHandler({ store: s2, email: sender(svc) });
    expect(await createNotificationDeliveryProcessor(h2)(job)).toEqual({ status: 'skipped' });
    expect(svc.sent).toHaveLength(0);
  });
  it('unverified/deleted user: skipped; provider error: transient with a code only', async () => {
    const { s } = dstore();
    const h = createNotificationDeliveryHandler({
      store: s,
      email: sender(
        emailService(),
        vi.fn(async () => undefined),
      ),
    });
    expect(await createNotificationDeliveryProcessor(h)(job)).toEqual({ status: 'skipped' });
    const h2 = createNotificationDeliveryHandler({ store: s, email: sender(emailService(true)) });
    const err = await h2.deliver(job.data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientNotificationError);
    expect(String((err as Error).message)).not.toContain('@');
  });
  it('other kinds or a payload that fails the strict contract are rejected permanently', async () => {
    const svc = emailService();
    const { s } = dstore({
      // Even with email enabled for another kind, this sender never renders it.
      preferences: async () => [{ type: '*', channel: 'email', enabled: true }],
      findNotification: async (_o, _u, id) => ({
        id,
        type: 'meeting.summary_ready',
        createdAt: new Date(0),
        data: {},
      }),
    });
    await expect(
      createNotificationDeliveryHandler({ store: s, email: sender(svc) }).deliver(job.data),
    ).rejects.toBeInstanceOf(PermanentNotificationError);
    const { s: s2 } = dstore({
      findNotification: async (_o, _u, id) => ({
        id,
        type: 'auth.new_location_signin',
        createdAt: new Date(0),
        data: { ...data, ip: '81.2.69.142' },
      }),
    });
    await expect(
      createNotificationDeliveryHandler({ store: s2, email: sender(svc) }).deliver(job.data),
    ).rejects.toBeInstanceOf(PermanentNotificationError);
    expect(svc.sent).toHaveLength(0);
  });
});
