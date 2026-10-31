import { describe, expect, it, vi } from 'vitest';
import type { CalendarSyncEventInput, CalendarSyncSecrets } from '@meetops/database';
import {
  CALENDAR_SYNC_DEFAULTS,
  calendarSyncBackoffMs,
  loadCalendarSyncEnv,
  runCalendarSyncSweep,
  startCalendarSyncScheduler,
  type CalendarSyncProvider,
  type CalendarSyncSweepRepository,
} from '../src/calendar/index.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const USER = '00000000-0000-4000-8000-0000000000b1';
const NOW = Date.parse('2026-10-31T10:00:00Z');
const DAY = 86_400_000;

const ev = (id: string, over: Partial<CalendarSyncEventInput> = {}): CalendarSyncEventInput => ({
  id,
  title: `t-${id}`,
  startsAt: '2026-11-01T09:00:00.000Z',
  endsAt: '2026-11-01T10:00:00.000Z',
  allDay: false,
  attendeeCount: 1,
  status: 'confirmed',
  ...over,
});

const secrets = (over: Partial<CalendarSyncSecrets> = {}): CalendarSyncSecrets => ({
  userId: USER,
  provider: 'google',
  accessToken: 'access-placeholder',
  refreshToken: 'refresh-placeholder',
  accessTokenExpiresAt: new Date(NOW + 3_600_000),
  syncFailures: 0,
  ...over,
});

function makeRepo(conns: { id: string; provider?: string; s: CalendarSyncSecrets | null }[]) {
  const calls = {
    applied: [] as Parameters<CalendarSyncSweepRepository['applySync']>[1][],
    tokens: [] as [string, Parameters<CalendarSyncSweepRepository['updateTokens']>[2]][],
    errors: [] as string[],
    failures: [] as [string, { syncFailures: number; nextSyncAt: Date }][],
  };
  const repo: CalendarSyncSweepRepository = {
    listDueForSync: vi.fn(async () =>
      conns.map((c) => ({
        organizationId: ORG,
        id: c.id,
        userId: USER,
        provider: c.provider ?? 'google',
      })),
    ),
    readSecrets: async (_o, id) => conns.find((c) => c.id === id)?.s ?? null,
    updateTokens: async (_o, id, t) => void calls.tokens.push([id, t]),
    markError: async (_o, id) => void calls.errors.push(id),
    recordFailure: async (_o, id, s) => void calls.failures.push([id, s]),
    applySync: async (_o, input) => {
      calls.applied.push(input);
      return { upserted: input.events.length, cancelled: input.complete ? 1 : 0, applied: true };
    },
  };
  return { repo, calls };
}

function provider(over: Partial<CalendarSyncProvider> = {}) {
  return {
    refresh: vi.fn<CalendarSyncProvider['refresh']>(async () => ({
      accessToken: 'new-access-placeholder',
      refreshToken: '',
      expiresAt: NOW + 3_600_000,
    })),
    listEvents: vi.fn<CalendarSyncProvider['listEvents']>(async () => [ev('a'), ev('b')]),
    ...over,
  };
}

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('runCalendarSyncSweep', () => {
  it('pulls the rolling window, applies a complete sync and schedules the next one', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider();
    const l = log();
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: l,
      now: () => NOW,
    });
    expect(r).toEqual({ synced: 1, failed: 0, skipped: 0, upserted: 2, cancelled: 1 });
    expect(p.refresh).not.toHaveBeenCalled();
    expect(p.listEvents).toHaveBeenCalledWith({
      accessToken: 'access-placeholder',
      timeMin: new Date(NOW - DAY).toISOString(),
      timeMax: new Date(NOW + 30 * DAY).toISOString(),
      maxResults: 250,
    });
    expect(calls.applied[0]).toMatchObject({
      connectionId: C1,
      complete: true,
      from: new Date(NOW - DAY),
      to: new Date(NOW + 30 * DAY),
      now: new Date(NOW),
      nextSyncAt: new Date(NOW + CALENDAR_SYNC_DEFAULTS.intervalMs),
    });
  });

  it('refreshes an expiring token first and stores it (empty refresh token passed through to keep the old one)', async () => {
    const { repo, calls } = makeRepo([
      { id: C1, s: secrets({ accessTokenExpiresAt: new Date(NOW + 60_000) }) },
    ]);
    const p = provider();
    await runCalendarSyncSweep({ repo, providers: { google: p }, log: log(), now: () => NOW });
    expect(p.refresh).toHaveBeenCalledWith('refresh-placeholder');
    expect(calls.tokens).toEqual([
      [
        C1,
        {
          accessToken: 'new-access-placeholder',
          refreshToken: '',
          accessTokenExpiresAt: new Date(NOW + 3_600_000),
        },
      ],
    ]);
    expect(p.listEvents.mock.calls[0]![0].accessToken).toBe('new-access-placeholder');
  });

  it('treats a full provider page as truncated: upserts but never cancels', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider({ listEvents: vi.fn(async () => [ev('a'), ev('b'), ev('c')]) });
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
      config: { maxEvents: 3 },
    });
    expect(calls.applied[0]!.complete).toBe(false);
  });

  it('marks the connection error on a permanent auth failure, without backoff bookkeeping', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider({
      listEvents: vi.fn(async () => {
        throw Object.assign(new Error('Calendar provider failed: http_error (401)'), {
          name: 'CalendarProviderError',
          status: 401,
        });
      }),
    });
    const l = log();
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: l,
      now: () => NOW,
    });
    expect(r.failed).toBe(1);
    expect(calls.errors).toEqual([C1]);
    expect(calls.failures).toEqual([]);
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: C1, permanent: true, errStatus: 401 }),
      'calendar sync failed',
    );
  });

  it('backs off exponentially on transient failures (429/5xx/network) and keeps the connection active', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets({ syncFailures: 2 }) }]);
    const p = provider({
      listEvents: vi.fn(async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }),
    });
    await runCalendarSyncSweep({ repo, providers: { google: p }, log: log(), now: () => NOW });
    expect(calls.errors).toEqual([]);
    expect(calls.failures).toEqual([
      [C1, { syncFailures: 3, nextSyncAt: new Date(NOW + 4 * CALENDAR_SYNC_DEFAULTS.intervalMs) }],
    ]);
  });

  it('a refresh invalid_grant is permanent', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets({ accessTokenExpiresAt: null }) }]);
    const p = provider({
      refresh: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'invalid_grant' });
      }),
    });
    await runCalendarSyncSweep({ repo, providers: { google: p }, log: log(), now: () => NOW });
    expect(calls.errors).toEqual([C1]);
    expect(p.listEvents).not.toHaveBeenCalled();
  });

  it('one failing connection does not stop the others; unknown providers and missing secrets are skipped', async () => {
    const C3 = '00000000-0000-4000-8000-0000000000c3';
    const { repo, calls } = makeRepo([
      { id: C1, s: secrets() },
      { id: C2, s: null },
      { id: C3, provider: 'outlook', s: secrets() },
    ]);
    const p = provider({
      listEvents: vi
        .fn<CalendarSyncProvider['listEvents']>()
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    });
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
    });
    expect(r).toMatchObject({ synced: 0, failed: 1, skipped: 2 });
    expect(calls.failures[0]![0]).toBe(C1);
  });

  it('never logs token material', async () => {
    const { repo } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider({
      listEvents: vi.fn(async () => {
        throw new Error('boom access-placeholder');
      }),
    });
    const l = log();
    await runCalendarSyncSweep({ repo, providers: { google: p }, log: l, now: () => NOW });
    const logged = JSON.stringify([...l.warn.mock.calls, ...l.info.mock.calls]);
    expect(logged).not.toContain('placeholder');
  });

  it('caps the window at 62 days', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    await runCalendarSyncSweep({
      repo,
      providers: { google: provider() },
      log: log(),
      now: () => NOW,
      config: { pastMs: 30 * DAY, futureMs: 60 * DAY },
    });
    const a = calls.applied[0]!;
    expect(a.to.getTime() - a.from.getTime()).toBe(62 * DAY);
  });
});

describe('helpers', () => {
  it('backoff doubles from the interval and is capped', () => {
    const cfg = CALENDAR_SYNC_DEFAULTS;
    expect(calendarSyncBackoffMs(1, cfg)).toBe(cfg.intervalMs);
    expect(calendarSyncBackoffMs(3, cfg)).toBe(4 * cfg.intervalMs);
    expect(calendarSyncBackoffMs(50, cfg)).toBe(cfg.maxBackoffMs);
  });

  it('is off by default and parses/clamps env', () => {
    expect(loadCalendarSyncEnv({}).enabled).toBe(false);
    expect(loadCalendarSyncEnv({ CALENDAR_SYNC_ENABLED: '1' }).enabled).toBe(false);
    const e = loadCalendarSyncEnv({
      CALENDAR_SYNC_ENABLED: 'true',
      CALENDAR_SYNC_FUTURE_DAYS: '14',
      CALENDAR_SYNC_BATCH: '9999',
    });
    expect(e.enabled).toBe(true);
    expect(e.config.futureMs).toBe(14 * DAY);
    expect(e.config.limit).toBe(CALENDAR_SYNC_DEFAULTS.limit);
  });

  it('scheduler does not overlap sweeps and close waits for the in-flight one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { repo } = makeRepo([]);
    const listDue = vi.fn(async () => {
      await gate;
      return [];
    });
    repo.listDueForSync = listDue;
    const s = startCalendarSyncScheduler(
      { repo, providers: {}, log: log() },
      { tickMs: 3_600_000 },
    );
    const a = s.tick();
    const b = s.tick();
    expect(a).toBe(b);
    release();
    await s.close();
    expect(listDue).toHaveBeenCalledTimes(1);
  });
});
