import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@meetops/database';
import {
  createInAppPublisher,
  createPrismaDeliveryStore,
  createPrismaFanoutStore,
  createPrismaOutboxSource,
  loadNotificationsWorkerEnv,
  registerNotificationsWorker,
  startOutboxRelay,
  userRoom,
} from '../src/notifications/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const U = '44444444-4444-4444-8444-000000000001';
const EV = '66666666-6666-4666-8666-666666666666';
const logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Records raw SQL and GUCs; membership rows for the fan-out store. */
function fakeDb(members: Array<{ userId: string; role: string; deletedAt: Date | null }> = []) {
  const sql: string[] = [];
  const gucs: string[] = [];
  const raw = (s: TemplateStringsArray, ...v: unknown[]) => {
    sql.push(s.join('$'));
    return v;
  };
  const tx = {
    $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
      gucs.push(`${String(v[0])}=${String(v[1])}`);
      void s;
      return 1;
    },
    membership: {
      findMany: async ({ where }: { where: { role: { in: string[] }; deletedAt: null } }) =>
        members
          .filter((m) => m.deletedAt === null && where.role.in.includes(m.role))
          .map((m) => ({ userId: m.userId })),
      count: async ({ where }: { where: { userId: string } }) =>
        members.filter((m) => m.userId === where.userId && m.deletedAt === null).length,
    },
  };
  const client = {
    $queryRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
      raw(s, ...v);
      if (s.join('').includes('relay_claim_outbox_events'))
        return [
          {
            id: EV,
            org_id: ORG,
            aggregate_type: 'meeting',
            aggregate_id: EV,
            event_type: 'x',
            payload: { a: 1 },
            attempts: 2,
          },
        ];
      return [{ relay_complete_outbox_event: true }];
    }),
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as DatabaseClient & { $queryRaw: ReturnType<typeof vi.fn> };
  return { client, sql, gucs };
}

describe('outbox source (definer functions only)', () => {
  it('claims via relay_claim_outbox_events and completes via relay_complete_outbox_event', async () => {
    const db = fakeDb();
    const src = createPrismaOutboxSource(db.client);
    expect(await src.claim(9999)).toEqual([
      {
        id: EV,
        organizationId: ORG,
        aggregateType: 'meeting',
        aggregateId: EV,
        eventType: 'x',
        payload: { a: 1 },
        attempts: 2,
      },
    ]);
    expect(db.client.$queryRaw.mock.calls[0]!.slice(1)).toEqual([500]);
    await src.complete(EV, { published: false, error: 'E'.repeat(300), retryAt: new Date(5) });
    await src.complete(EV, { published: true });
    expect(db.sql.every((s) => /relay_(claim|complete)_outbox_event/.test(s))).toBe(true);
    expect(db.sql.join(' ')).not.toMatch(/FROM\s+"?outbox_events/i);
    const args = db.client.$queryRaw.mock.calls[1]!.slice(1);
    expect(args).toEqual([EV, false, 'E'.repeat(200), new Date(5)]);
    expect(db.client.$queryRaw.mock.calls[2]!.slice(1)).toEqual([EV, true, null, null]);
  });
});

describe('fan-out + delivery stores (org context)', () => {
  const repo = {
    getPreferences: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 'n1' })),
    findForUser: vi.fn(async () => ({ id: 'n1', type: 'k', createdAt: new Date(0) })),
    listActiveDevices: vi.fn(async () => [{ id: 'd', platform: 'ios', token: 't' }]),
    unregisterDevice: vi.fn(async () => true),
    recordAttempt: vi.fn(async () => {}),
  };
  it('recipients: active members with the rule roles, inside app.current_organization_id', async () => {
    const db = fakeDb([
      { userId: 'a', role: 'owner', deletedAt: null },
      { userId: 'b', role: 'viewer', deletedAt: null },
      { userId: 'c', role: 'member', deletedAt: new Date() },
    ]);
    const store = createPrismaFanoutStore(repo as never, db.client);
    expect(await store.recipients(ORG, ['owner', 'member'])).toEqual(['a']);
    expect(db.gucs).toContain(`app.current_organization_id=${ORG}`);
  });
  it('delivery store re-checks membership and skips push devices without a cipher', async () => {
    const db = fakeDb([{ userId: U, role: 'member', deletedAt: null }]);
    const off = createPrismaDeliveryStore(repo as never, { client: db.client, pushEnabled: false });
    expect(await off.isActiveMember(ORG, U)).toBe(true);
    expect(await off.isActiveMember(ORG, 'other')).toBe(false);
    expect(await off.activeDevices(ORG, U)).toEqual([]);
    expect(repo.listActiveDevices).not.toHaveBeenCalled();
    const on = createPrismaDeliveryStore(repo as never, { client: db.client, pushEnabled: true });
    expect(await on.activeDevices(ORG, U)).toHaveLength(1);
  });
});

describe('in-app publisher', () => {
  it('emits notification:new to the user room only', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const e = { organizationId: ORG, notificationId: EV, kind: 'k', at: 'now' };
    void createInAppPublisher({ to }).notificationNew(U, e);
    expect(to).toHaveBeenCalledWith(`organizations:${ORG}:users:${U}`);
    expect(userRoom(ORG, U)).toBe(`organizations:${ORG}:users:${U}`);
    expect(emit).toHaveBeenCalledWith('notification:new', e);
  });
});

describe('relay loop and registration', () => {
  it('passes never overlap; a full batch drains immediately; stop waits for the in-flight pass', async () => {
    const timers: Array<[() => void, number]> = [];
    let active = 0;
    let maxActive = 0;
    const batches = [[1, 2], [1]];
    const source = {
      claim: vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return (batches.shift() ?? []).map((i) => ({
          id: `${i}`,
          organizationId: ORG,
          aggregateType: 'm',
          aggregateId: 'x',
          eventType: 'unknown',
          payload: {},
          attempts: 1,
        }));
      }),
      complete: vi.fn(async () => {}),
    };
    const loop = startOutboxRelay({
      source,
      store: {
        recipients: async () => [],
        preferences: async () => [],
        createNotification: async () => ({ id: 'n' }),
      },
      producer: { enqueue: async () => undefined },
      logger,
      intervalMs: 5000,
      batch: 2,
      setTimer: (fn, ms) => timers.push([fn, ms]),
      clearTimer: () => {},
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]![1]).toBe(0);
    timers[0]![0]();
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(timers[1]![1]).toBe(5000);
    await loop.stop();
    expect(maxActive).toBe(1);
    expect(source.complete).toHaveBeenCalledTimes(3);
  });
  it('env defaults and registration gates', () => {
    expect(loadNotificationsWorkerEnv({})).toEqual({
      enabled: false,
      relayIntervalMs: 5000,
      relayBatch: 100,
      concurrency: 5,
    });
    const producer = { enqueue: async () => undefined };
    expect(
      registerNotificationsWorker({ env: { ...loadNotificationsWorkerEnv({}) }, producer, logger }),
    ).toEqual({ registered: false, reason: 'disabled' });
    expect(
      registerNotificationsWorker({
        env: { ...loadNotificationsWorkerEnv({ NOTIFICATIONS_WORKER_ENABLED: 'true' }) },
        producer,
        logger,
      }),
    ).toEqual({ registered: false, reason: 'missing_dependencies' });
  });
});
