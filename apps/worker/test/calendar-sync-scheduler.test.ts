import { describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_SYNC_QUEUE,
  CALENDAR_SYNC_SCHEDULER_ID,
  CalendarSyncEnvError,
  calendarSyncProvidersFromEnv,
  loadCalendarSyncEnv,
  registerCalendarSyncScheduler,
  scheduleCalendarSync,
} from '../src/calendar/index.js';

// Fixture KEK: 32 zero bytes, base64. Not a real key.
const FAKE_KEK = Buffer.alloc(32).toString('base64');
const log = () => ({ info: vi.fn(), warn: vi.fn() });

/** In-memory stand-in for BullMQ's job schedulers: upsert by id, like the real Queue. */
function fakeQueue() {
  const schedulers = new Map<string, { every: number; name: string }>();
  return {
    schedulers,
    upsertJobScheduler: vi.fn(
      async (id: string, repeat: { every: number }, t: { name: string }) => {
        schedulers.set(id, { every: repeat.every, name: t.name });
      },
    ),
    close: vi.fn(async () => undefined),
  };
}

function setup(over: { env?: NodeJS.ProcessEnv; queue?: ReturnType<typeof fakeQueue> } = {}) {
  const queue = over.queue ?? fakeQueue();
  const order: string[] = [];
  queue.close.mockImplementation(async () => void order.push('queue'));
  let processor: (() => Promise<unknown>) | undefined;
  const worker = { close: vi.fn(async () => void order.push('worker')) };
  const repo = { listDueForSync: vi.fn(async () => []) };
  const processEnv = { INTEGRATIONS_TOKEN_KEK: FAKE_KEK, ...over.env };
  const reg = registerCalendarSyncScheduler({
    env: loadCalendarSyncEnv({ CALENDAR_SYNC_ENABLED: 'true', ...processEnv }),
    log: log(),
    processEnv,
    buildDeps: () => ({ repo: repo as never, providers: {} }),
    createQueue: () => queue,
    createWorker: (name, p, o) => {
      expect(name).toBe(CALENDAR_SYNC_QUEUE);
      expect(o.concurrency).toBe(1);
      processor = p;
      return worker;
    },
  });
  return { reg, queue, worker, repo, order, run: () => processor!() };
}

describe('calendar sync scheduler', () => {
  it('is off by default and touches no queue', () => {
    const createQueue = vi.fn();
    const reg = registerCalendarSyncScheduler({
      env: loadCalendarSyncEnv({}),
      log: log(),
      createQueue,
    });
    expect(reg).toEqual({ registered: false, reason: 'disabled' });
    expect(createQueue).not.toHaveBeenCalled();
  });

  it('fails closed when enabled without a valid KEK', () => {
    expect(() =>
      registerCalendarSyncScheduler({
        env: loadCalendarSyncEnv({ CALENDAR_SYNC_ENABLED: 'true' }),
        log: log(),
        processEnv: {},
        createQueue: vi.fn(),
      }),
    ).toThrow(CalendarSyncEnvError);
  });

  it('upserts one repeatable at the configured tick (default 60 s)', async () => {
    const { reg, queue } = setup();
    if (!reg.registered) throw new Error('expected registered');
    await reg.ready;
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      CALENDAR_SYNC_SCHEDULER_ID,
      { every: 60_000 },
      expect.objectContaining({ name: 'sweep' }),
    );
    const t = setup({ env: { CALENDAR_SYNC_TICK_MS: '120000' } });
    if (!t.reg.registered) throw new Error('expected registered');
    await t.reg.ready;
    expect(t.queue.schedulers.get(CALENDAR_SYNC_SCHEDULER_ID)?.every).toBe(120_000);
  });

  it('is restart safe: re-registering keeps a single scheduler', async () => {
    const queue = fakeQueue();
    for (const tick of ['60000', '60000', '90000']) {
      const { reg } = setup({ queue, env: { CALENDAR_SYNC_TICK_MS: tick } });
      if (!reg.registered) throw new Error('expected registered');
      await reg.ready;
      await reg.close();
    }
    expect(queue.schedulers.size).toBe(1);
    expect(queue.schedulers.get(CALENDAR_SYNC_SCHEDULER_ID)?.every).toBe(90_000);
  });

  it('the job runs one sweep through the repository', async () => {
    const { run, repo } = setup();
    await expect(run()).resolves.toMatchObject({ synced: 0, failed: 0 });
    expect(repo.listDueForSync).toHaveBeenCalledWith(expect.any(Date), 200); // limit 50 x4 headroom for per-org round-robin;
  });

  it('closes the worker before the queue', async () => {
    const { reg, order } = setup();
    if (!reg.registered) throw new Error('expected registered');
    await reg.close();
    expect(order).toEqual(['worker', 'queue']);
  });

  it('surfaces a schedule failure (startup fails) and still closes cleanly', async () => {
    const queue = fakeQueue();
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));
    const { reg, worker } = setup({ queue });
    if (!reg.registered) throw new Error('expected registered');
    await expect(reg.ready).rejects.toThrow('redis down');
    await reg.close();
    expect(worker.close).toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalled();
  });

  it('scheduleCalendarSync uses the fixed id', async () => {
    const q = fakeQueue();
    await scheduleCalendarSync(q, 30_000);
    await scheduleCalendarSync(q, 30_000);
    expect([...q.schedulers.keys()]).toEqual([CALENDAR_SYNC_SCHEDULER_ID]);
  });

  it('only builds the Google provider when its client is configured', () => {
    expect(calendarSyncProvidersFromEnv({})).toEqual({});
    const p = calendarSyncProvidersFromEnv({
      NODE_ENV: 'test',
      GOOGLE_CALENDAR_CLIENT_ID: 'fixture-client-id',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'fixture-placeholder',
    });
    expect(Object.keys(p)).toEqual(['google']);
  });
});

describe('CALENDAR_SYNC_TICK_MS validation', () => {
  it('defaults to 60 s when unset or blank', () => {
    expect(loadCalendarSyncEnv({}).tickMs).toBe(60_000);
    expect(loadCalendarSyncEnv({ CALENDAR_SYNC_TICK_MS: ' ' }).tickMs).toBe(60_000);
  });
  it.each(['abc', '0', '-5', '1.5', '1000', '3600001', 'NaN', '1e9'])(
    'throws at startup on %s instead of falling back',
    (v) => {
      expect(() =>
        loadCalendarSyncEnv({ CALENDAR_SYNC_ENABLED: 'true', CALENDAR_SYNC_TICK_MS: v }),
      ).toThrow(CalendarSyncEnvError);
      expect(() => loadCalendarSyncEnv({ CALENDAR_SYNC_TICK_MS: v })).toThrow(
        /CALENDAR_SYNC_TICK_MS/,
      );
    },
  );
});

describe('OUTLOOK_CALENDAR_TENANT validation (worker)', () => {
  const env = {
    NODE_ENV: 'test',
    OUTLOOK_CALENDAR_CLIENT_ID: 'id',
    OUTLOOK_CALENDAR_CLIENT_SECRET: 'placeholder',
  };
  it('builds the Outlook provider for a domain or GUID tenant', () => {
    for (const t of ['contoso.onmicrosoft.com', '72f988bf-86f1-41af-91ab-2d7cd011db47', 'common'])
      expect(
        calendarSyncProvidersFromEnv({ ...env, OUTLOOK_CALENDAR_TENANT: t }).outlook,
      ).toBeDefined();
  });
  it('fails startup with CalendarSyncEnvError on a malformed tenant', () => {
    expect(() =>
      calendarSyncProvidersFromEnv({ ...env, OUTLOOK_CALENDAR_TENANT: 'not a tenant' }),
    ).toThrow(CalendarSyncEnvError);
    expect(() =>
      calendarSyncProvidersFromEnv({ ...env, OUTLOOK_CALENDAR_TENANT: 'contoso' }),
    ).toThrow(/OUTLOOK_CALENDAR_TENANT must be/);
  });
});
