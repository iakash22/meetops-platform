import { describe, expect, it, vi } from 'vitest';
import type { CalendarSyncEventInput, CalendarSyncSecrets } from '@meetops/database';
import {
  calendarSyncBackoffMs,
  CALENDAR_SYNC_DEFAULTS,
  loadCalendarSyncEnv,
  outlookSyncProvider,
  runCalendarSyncSweep,
  selectFairly,
  type CalendarSyncProvider,
  type CalendarSyncSweepRepository,
} from '../src/calendar/index.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const NOW = Date.parse('2026-11-03T10:00:00Z');
const LEASE = new Date(NOW + 600_000);
const DAY = 86_400_000;
const FROM = new Date(NOW - DAY);
const TO = new Date(NOW + 30 * DAY);

const ev = (id: string): CalendarSyncEventInput => ({
  id,
  title: `t-${id}`,
  startsAt: '2026-11-04T09:00:00.000Z',
  endsAt: '2026-11-04T10:00:00.000Z',
  allDay: false,
  attendeeCount: 1,
  status: 'confirmed',
});

const secrets = (over: Partial<CalendarSyncSecrets> = {}): CalendarSyncSecrets => ({
  userId: USER,
  provider: 'outlook',
  accessToken: 'access-placeholder',
  refreshToken: 'refresh-placeholder',
  accessTokenExpiresAt: new Date(NOW + 3_600_000),
  syncFailures: 0,
  syncCursor: null,
  ...over,
});

function makeRepo(
  s: CalendarSyncSecrets,
  due = [{ organizationId: ORG, id: C1, userId: USER, provider: 'outlook' }],
) {
  const applied: Parameters<CalendarSyncSweepRepository['applySync']>[1][] = [];
  const failures: { syncFailures: number; retryInMs: number }[] = [];
  const errors: string[] = [];
  const listDue = vi.fn(async () => due);
  const claim = vi.fn<CalendarSyncSweepRepository['claimForSync']>(async () => ({ lease: LEASE }));
  const repo: CalendarSyncSweepRepository = {
    listDueForSync: listDue,
    claimForSync: claim,
    readSecrets: async () => s,
    updateTokens: async () => undefined,
    markError: async (_o, id) => void errors.push(id),
    recordFailure: async (_o, _id, f) => {
      failures.push(f);
      return true;
    },
    applySync: async (_o, input) => {
      applied.push(input);
      return { upserted: input.events.length, cancelled: 0, applied: true };
    },
  };
  return { repo, applied, failures, errors, listDue, claim };
}

function deltaProvider(impl: NonNullable<CalendarSyncProvider['listEventsDelta']>) {
  return {
    refresh: vi.fn<CalendarSyncProvider['refresh']>(),
    listEvents: vi.fn<CalendarSyncProvider['listEvents']>(async () => [ev('w')]),
    listEventsDelta: vi.fn(impl),
  };
}

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const run = (repo: CalendarSyncSweepRepository, p: CalendarSyncProvider, delta = true) =>
  runCalendarSyncSweep({
    repo,
    providers: { outlook: p, google: p },
    log: log(),
    now: () => NOW,
    random: () => 0.5,
    config: { deltaEnabled: delta },
  });

describe('calendar delta sync', () => {
  it('with no cursor opens a new round for the window: complete list, cursor stored', async () => {
    const { repo, applied } = makeRepo(secrets());
    const p = deltaProvider(async () => ({ events: [ev('a')], removedIds: [], cursor: 'cur-1' }));
    await run(repo, p);
    expect(p.listEventsDelta).toHaveBeenCalledWith({
      accessToken: 'access-placeholder',
      timeMin: FROM.toISOString(),
      timeMax: TO.toISOString(),
    });
    expect(p.listEvents).not.toHaveBeenCalled();
    expect(applied[0]).toMatchObject({ from: FROM, to: TO, complete: true, cursor: 'cur-1' });
  });

  it('with a fresh cursor applies only the changes (removed ids cancelled, no window sweep)', async () => {
    const c = {
      value: 'cur-1',
      from: new Date(FROM.getTime() - 3_600_000),
      to: new Date(TO.getTime() - 3_600_000),
    };
    const { repo, applied } = makeRepo(secrets({ syncCursor: c }));
    const p = deltaProvider(async () => ({
      events: [ev('b')],
      removedIds: ['gone'],
      cursor: 'cur-2',
    }));
    await run(repo, p);
    expect(p.listEventsDelta).toHaveBeenCalledWith({
      accessToken: 'access-placeholder',
      timeMin: c.from.toISOString(),
      timeMax: c.to.toISOString(),
      cursor: 'cur-1',
    });
    expect(applied[0]).toMatchObject({
      from: c.from,
      to: c.to,
      complete: false,
      removedIds: ['gone'],
      cursor: 'cur-2',
    });
  });

  it('restarts the round once the cursor window lags the rolling window by more than a day', async () => {
    const c = {
      value: 'old',
      from: new Date(FROM.getTime() - 2 * DAY),
      to: new Date(TO.getTime() - 2 * DAY),
    };
    const { repo, applied } = makeRepo(secrets({ syncCursor: c }));
    const p = deltaProvider(async () => ({ events: [], removedIds: [], cursor: 'new' }));
    await run(repo, p);
    expect(p.listEventsDelta).toHaveBeenCalledTimes(1);
    expect(p.listEventsDelta.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(applied[0]).toMatchObject({ from: FROM, to: TO, complete: true, cursor: 'new' });
  });

  it('an expired cursor (sync_state_expired) falls back to a new round in the same sweep', async () => {
    const c = { value: 'cur-x', from: FROM, to: TO };
    const { repo, applied, failures } = makeRepo(secrets({ syncCursor: c }));
    const p = deltaProvider(async (i) => {
      if (i.cursor) throw Object.assign(new Error('expired'), { code: 'sync_state_expired' });
      return { events: [ev('a')], removedIds: [], cursor: 'fresh' };
    });
    const r = await run(repo, p);
    expect(r.synced).toBe(1);
    expect(failures).toEqual([]);
    expect(applied[0]).toMatchObject({ complete: true, cursor: 'fresh' });
  });

  it('rate_limited from the delta call backs off with jitter and keeps the cursor and connection', async () => {
    const c = { value: 'cur-1', from: FROM, to: TO };
    const { repo, applied, failures, errors } = makeRepo(
      secrets({ syncCursor: c, syncFailures: 2 }),
    );
    const p = deltaProvider(async () => {
      throw Object.assign(new Error('429'), { code: 'rate_limited', status: 429 });
    });
    await run(repo, p);
    expect(applied).toEqual([]);
    expect(errors).toEqual([]);
    const cfg = { ...CALENDAR_SYNC_DEFAULTS, deltaEnabled: true };
    expect(failures).toEqual([
      expect.objectContaining({
        syncFailures: 3,
        retryInMs: calendarSyncBackoffMs(3, cfg, () => 0.5),
      }),
    ]);
  });

  it('flag off (default): delta-capable providers use the windowed list, a stale cursor is cleared', async () => {
    const { repo, applied } = makeRepo(secrets({ syncCursor: { value: 'c', from: FROM, to: TO } }));
    const p = deltaProvider(async () => ({ events: [], removedIds: [], cursor: 'x' }));
    await run(repo, p, false);
    expect(p.listEventsDelta).not.toHaveBeenCalled();
    expect(p.listEvents).toHaveBeenCalled();
    expect(applied[0]).toMatchObject({ complete: true, cursor: null });
  });

  it('providers without delta (Google) keep the windowed list and never set a cursor', async () => {
    const { repo, applied } = makeRepo(secrets({ provider: 'google' }), [
      { organizationId: ORG, id: C1, userId: USER, provider: 'google' },
    ]);
    const p = { refresh: vi.fn(), listEvents: vi.fn(async () => [ev('g')]) };
    await run(repo, p);
    expect(p.listEvents).toHaveBeenCalled();
    expect(applied[0]).not.toHaveProperty('cursor');
  });

  it('outlookSyncProvider maps cursor <-> deltaLink', async () => {
    const o = {
      refresh: vi.fn(),
      listEvents: vi.fn(),
      listEventsDelta: vi.fn(async () => ({
        events: [ev('a')],
        removedIds: ['r'],
        deltaLink: 'dl-2',
      })),
    };
    const p = outlookSyncProvider(o);
    const r = await p.listEventsDelta!({
      accessToken: 'a',
      timeMin: 'x',
      timeMax: 'y',
      cursor: 'dl-1',
    });
    expect(o.listEventsDelta).toHaveBeenCalledWith({
      accessToken: 'a',
      timeMin: 'x',
      timeMax: 'y',
      deltaLink: 'dl-1',
    });
    expect(r).toEqual({ events: [ev('a')], removedIds: ['r'], cursor: 'dl-2' });
  });
});

describe('per-org scheduling', () => {
  const d = (org: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ organizationId: org, id: `${org}-${i}` }));

  it('round-robins across orgs with a per-org cap and a total limit', () => {
    const due = [...d('big', 6), ...d('a', 2), ...d('b', 1)];
    expect(selectFairly(due, 5, 10).map((x) => x.id)).toEqual([
      'big-0',
      'a-0',
      'b-0',
      'big-1',
      'a-1',
    ]);
    expect(selectFairly(due, 50, 2).map((x) => x.id)).toEqual([
      'big-0',
      'a-0',
      'b-0',
      'big-1',
      'a-1',
    ]);
  });

  it('the sweep over-fetches and claims at most perOrgLimit per org', async () => {
    const due = [
      ...d('o1', 4).map((x) => ({ ...x, userId: USER, provider: 'outlook' })),
      { organizationId: 'o2', id: 'o2-0', userId: USER, provider: 'outlook' },
    ];
    const { repo, listDue, claim } = makeRepo(secrets(), due);
    const p = deltaProvider(async () => ({ events: [], removedIds: [], cursor: 'c' }));
    await runCalendarSyncSweep({
      repo,
      providers: { outlook: p },
      log: log(),
      now: () => NOW,
      config: { limit: 3, perOrgLimit: 2, deltaEnabled: true },
    });
    expect(listDue).toHaveBeenCalledWith(expect.any(Date), 12);
    expect(claim.mock.calls.map((c) => c[1])).toEqual(['o1-0', 'o2-0', 'o1-1']);
  });

  it('env: delta flag off by default; per-org limit parsed', () => {
    expect(loadCalendarSyncEnv({}).config).toMatchObject({ deltaEnabled: false, perOrgLimit: 10 });
    expect(
      loadCalendarSyncEnv({ CALENDAR_SYNC_DELTA_ENABLED: 'true', CALENDAR_SYNC_PER_ORG_LIMIT: '3' })
        .config,
    ).toMatchObject({ deltaEnabled: true, perOrgLimit: 3 });
  });
});
