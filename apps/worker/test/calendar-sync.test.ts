import { describe, expect, it, vi } from 'vitest';
import type { CalendarSyncEventInput, CalendarSyncSecrets } from '@meetops/database';
import {
  CALENDAR_SYNC_DEFAULTS,
  CALENDAR_SYNC_LEASE_MS,
  calendarSyncBackoffMs,
  calendarSyncNextMs,
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
const LEASE = new Date(NOW + 600_000);
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
  syncCursor: null,
  ...over,
});

function makeRepo(conns: { id: string; provider?: string; s: CalendarSyncSecrets | null }[]) {
  const calls = {
    applied: [] as Parameters<CalendarSyncSweepRepository['applySync']>[1][],
    tokens: [] as [string, Parameters<CalendarSyncSweepRepository['updateTokens']>[2]][],
    errors: [] as string[],
    errorLeases: [] as (Date | undefined)[],
    tokenLeases: [] as (Date | undefined)[],
    failures: [] as [string, { syncFailures: number; retryInMs: number; lease: Date }][],
  };
  const repo: CalendarSyncSweepRepository = {
    claimForSync: vi.fn(async () => ({ lease: LEASE })),
    listDueForSync: vi.fn(async () =>
      conns.map((c) => ({
        organizationId: ORG,
        id: c.id,
        userId: USER,
        provider: c.provider ?? 'google',
      })),
    ),
    readSecrets: async (_o, id) => conns.find((c) => c.id === id)?.s ?? null,
    updateTokens: async (_o, id, t, opts) => {
      calls.tokens.push([id, t]);
      calls.tokenLeases.push(opts?.lease);
    },
    markError: async (_o, id, opts) => {
      calls.errors.push(id);
      calls.errorLeases.push(opts?.lease);
    },
    recordFailure: async (_o, id, s) => {
      calls.failures.push([id, s]);
      return true;
    },
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
      random: () => 0.5,
    });
    expect(r).toEqual({
      synced: 1,
      failed: 0,
      skipped: 0,
      upserted: 2,
      cancelled: 1,
      autoLinked: 0,
    });
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
      nextSyncInMs: 1.05 * CALENDAR_SYNC_DEFAULTS.intervalMs,
      lease: LEASE,
    });
  });

  it('refreshes an expiring token first and stores it (empty refresh token passed through to keep the old one)', async () => {
    const { repo, calls } = makeRepo([
      { id: C1, s: secrets({ accessTokenExpiresAt: new Date(NOW + 60_000) }) },
    ]);
    const p = provider();
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
    });
    expect(p.refresh).toHaveBeenCalledWith('refresh-placeholder');
    // Token writes are fenced by the sweep's claim, like applySync / recordFailure.
    expect(calls.tokenLeases).toEqual([LEASE]);
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
      random: () => 0.5,
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
      random: () => 0.5,
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
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
    });
    expect(calls.errors).toEqual([]);
    expect(calls.failures).toEqual([
      [C1, { syncFailures: 3, retryInMs: 4 * CALENDAR_SYNC_DEFAULTS.intervalMs, lease: LEASE }],
    ]);
  });

  it('L-2: Google 403 rateLimitExceeded / userRateLimitExceeded back off instead of marking error', async () => {
    for (const code of ['rate_limited']) {
      const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
      const p = provider({
        listEvents: vi.fn(async () => {
          throw Object.assign(new Error('Calendar provider failed: rate_limited (403)'), {
            name: 'CalendarProviderError',
            code,
            status: 403,
          });
        }),
      });
      await runCalendarSyncSweep({
        repo,
        providers: { google: p },
        log: log(),
        now: () => NOW,
        random: () => 0.5,
      });
      expect(calls.errors).toEqual([]);
      expect(calls.failures).toEqual([
        [C1, { syncFailures: 1, retryInMs: CALENDAR_SYNC_DEFAULTS.intervalMs, lease: LEASE }],
      ]);
    }
    // A plain 403 (no rate-limit reason) is still a permanent auth failure.
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider({
      listEvents: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'http_error', status: 403 });
      }),
    });
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
    });
    expect(calls.errors).toEqual([C1]);
  });

  it('a refresh invalid_grant is permanent', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets({ accessTokenExpiresAt: null }) }]);
    const p = provider({
      refresh: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'invalid_grant' });
      }),
    });
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
    });
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
      random: () => 0.5,
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
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: l,
      now: () => NOW,
      random: () => 0.5,
    });
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
      random: () => 0.5,
      config: { pastMs: 30 * DAY, futureMs: 60 * DAY },
    });
    const a = calls.applied[0]!;
    expect(a.to.getTime() - a.from.getTime()).toBe(62 * DAY);
  });
});

describe('helpers', () => {
  it('backoff doubles from the interval and is capped', () => {
    const cfg = CALENDAR_SYNC_DEFAULTS;
    const mid = () => 0.5;
    expect(calendarSyncBackoffMs(1, cfg, mid)).toBe(cfg.intervalMs);
    expect(calendarSyncBackoffMs(3, cfg, mid)).toBe(4 * cfg.intervalMs);
    expect(calendarSyncBackoffMs(50, cfg, mid)).toBe(cfg.maxBackoffMs);
  });

  it('L-1: jitters backoff to 80-120% and the healthy cadence to 100-110%', () => {
    const cfg = CALENDAR_SYNC_DEFAULTS;
    expect(calendarSyncBackoffMs(3, cfg, () => 0)).toBe(Math.round(0.8 * 4 * cfg.intervalMs));
    expect(calendarSyncBackoffMs(3, cfg, () => 0.999999)).toBeLessThanOrEqual(
      1.2 * 4 * cfg.intervalMs,
    );
    expect(calendarSyncBackoffMs(3, cfg, () => 0.999999)).toBeGreaterThan(
      1.19 * 4 * cfg.intervalMs,
    );
    expect(calendarSyncNextMs(cfg, () => 0)).toBe(cfg.intervalMs);
    expect(calendarSyncNextMs(cfg, () => 0.999999)).toBeGreaterThan(1.09 * cfg.intervalMs);
    // Bad random values never produce NaN dates.
    expect(Number.isFinite(calendarSyncBackoffMs(2, cfg, () => NaN))).toBe(true);
    // Real Math.random stays inside the band.
    for (let i = 0; i < 50; i++) {
      const v = calendarSyncBackoffMs(2, cfg);
      expect(v).toBeGreaterThanOrEqual(0.8 * 2 * cfg.intervalMs);
      expect(v).toBeLessThanOrEqual(1.2 * 2 * cfg.intervalMs);
    }
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

describe('calendar sync claim (multi-replica)', () => {
  it('skips a connection another replica already claimed, without touching tokens or the provider', async () => {
    const { repo, calls } = makeRepo([
      { id: C1, s: secrets() },
      { id: C2, s: secrets() },
    ]);
    const claim = vi.fn(async (_o: string, id: string) => (id === C2 ? { lease: LEASE } : null));
    repo.claimForSync = claim;
    const p = provider();
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
    });
    expect(r).toMatchObject({ synced: 1, skipped: 1 });
    expect(p.listEvents).toHaveBeenCalledTimes(1);
    expect(calls.applied.map((a) => a.connectionId)).toEqual([C2]);
    expect(claim).toHaveBeenCalledWith(ORG, C1, CALENDAR_SYNC_LEASE_MS);
  });

  it('times each connection from its own claim, not the sweep start (long sweep)', async () => {
    const { repo, calls } = makeRepo([
      { id: C1, s: secrets({ accessTokenExpiresAt: new Date(NOW + 3 * 3_600_000) }) },
      { id: C2, s: secrets({ accessTokenExpiresAt: new Date(NOW + 3 * 3_600_000) }) },
    ]);
    let t = NOW;
    const p = provider({
      listEvents: vi.fn(async () => {
        t += 30 * 60_000; // each provider call takes 30 min
        return [];
      }),
    });
    await runCalendarSyncSweep({
      repo,
      providers: { google: p },
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => t,
    });
    expect(calls.applied.map((a) => a.now)).toEqual([new Date(NOW), new Date(NOW + 30 * 60_000)]);
    expect(calls.applied.map((a) => a.from)).toEqual([
      new Date(NOW - DAY),
      new Date(NOW + 30 * 60_000 - DAY),
    ]);
    // relative delays only: the database adds them to its own clock at write time
    for (const a of calls.applied) expect(a).not.toHaveProperty('nextSyncAt');
  });

  it('#353 L1: the permanent-error mark is lease-guarded (passes the claim, like recordFailure/applySync)', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    const p = provider({
      listEvents: vi.fn(async () => {
        throw Object.assign(new Error('Calendar provider failed: http_error (401)'), {
          name: 'CalendarProviderError',
          status: 401,
        });
      }),
    });
    await runCalendarSyncSweep({ repo, providers: { google: p }, log: log(), now: () => NOW });
    expect(calls.errors).toEqual([C1]);
    expect(calls.errorLeases).toEqual([LEASE]);
  });

  it('does not record a failure when the claim was never won', async () => {
    const { repo, calls } = makeRepo([{ id: C1, s: secrets() }]);
    repo.claimForSync = vi.fn(async () => null);
    await runCalendarSyncSweep({
      repo,
      providers: { google: provider() },
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
    });
    expect(calls.failures).toEqual([]);
    expect(calls.applied).toEqual([]);
  });
});

describe('#394 token compare-and-set miss and delta maxEvents', () => {
  const expiring = (over: Partial<CalendarSyncSecrets> = {}) =>
    secrets({
      provider: 'outlook',
      accessTokenExpiresAt: new Date(NOW + 60_000),
      tokenGeneration: 4,
      refreshEncVersion: 2,
      ...over,
    });
  const rotating = () =>
    provider({
      refresh: vi.fn<CalendarSyncProvider['refresh']>(async () => ({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: NOW + 3_600_000,
      })),
    });

  it('retries once against the current generation when the stored refresh token is unchanged', async () => {
    const reads = [expiring(), expiring({ tokenGeneration: 5 })];
    const writes: (number | undefined)[] = [];
    const { repo } = makeRepo([{ id: C1, provider: 'outlook', s: null }]);
    repo.readSecrets = async () => reads.shift() ?? null;
    repo.updateTokens = async (_o, _id, _t, opts) => {
      writes.push(opts?.generation);
      return writes.length > 1; // first write misses, retry lands
    };
    const l = log();
    const p = rotating();
    const r = await runCalendarSyncSweep({
      repo,
      providers: { outlook: p },
      log: l,
      now: () => NOW,
      random: () => 0.5,
    });
    expect(writes).toEqual([4, 5]);
    expect(r.synced).toBe(1);
    expect(p.listEvents.mock.calls[0]![0].accessToken).toBe('rotated-access');
    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: C1 }),
      'calendar token CAS miss reconciled on retry',
    );
    expect(JSON.stringify([l.info.mock.calls, l.warn.mock.calls])).not.toMatch(/rotated/);
  });

  it('keeps a newer grant another writer stored instead of overwriting it', async () => {
    const reads = [
      expiring(),
      expiring({ tokenGeneration: 5, accessToken: 'other-access', refreshToken: 'other-refresh' }),
    ];
    let writes = 0;
    const { repo } = makeRepo([{ id: C1, provider: 'outlook', s: null }]);
    repo.readSecrets = async () => reads.shift() ?? null;
    repo.updateTokens = async () => {
      writes++;
      return false;
    };
    const l = log();
    const p = rotating();
    await runCalendarSyncSweep({
      repo,
      providers: { outlook: p },
      log: l,
      now: () => NOW,
      random: () => 0.5,
    });
    expect(writes).toBe(1);
    expect(p.listEvents.mock.calls[0]![0].accessToken).toBe('other-access');
    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: C1, generation: 5 }),
      'calendar token CAS miss: a newer grant is already stored; using it',
    );
  });

  it('logs and skips when the retry also misses or the connection is gone', async () => {
    for (const second of [expiring({ tokenGeneration: 6 }), null]) {
      const reads = [expiring(), second];
      const { repo, calls } = makeRepo([{ id: C1, provider: 'outlook', s: null }]);
      repo.readSecrets = async () => reads.shift() ?? null;
      repo.updateTokens = async () => false;
      const l = log();
      const p = rotating();
      const r = await runCalendarSyncSweep({
        repo,
        providers: { outlook: p },
        log: l,
        now: () => NOW,
        random: () => 0.5,
      });
      expect(r.skipped).toBe(1);
      expect(calls.applied).toHaveLength(0);
      expect(p.listEvents).not.toHaveBeenCalled();
      expect(l.warn).toHaveBeenCalledTimes(1);
    }
  });

  it('respects maxEvents on the delta path: truncates, never cancels, drops the cursor', async () => {
    const cursor = { value: 'cur-1', from: new Date(NOW - DAY), to: new Date(NOW + 30 * DAY) };
    const { repo, calls } = makeRepo([
      { id: C1, provider: 'outlook', s: secrets({ syncCursor: cursor }) },
    ]);
    const listEventsDelta = vi.fn<NonNullable<CalendarSyncProvider['listEventsDelta']>>(
      async () => ({
        events: [ev('a'), ev('b'), ev('c'), ev('d'), ev('e')],
        removedIds: ['x'],
        cursor: 'cur-2',
      }),
    );
    await runCalendarSyncSweep({
      repo,
      providers: { outlook: provider({ listEventsDelta }) },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
      config: { maxEvents: 3, deltaEnabled: true, cursorMaxLagMs: 365 * DAY },
    });
    expect(listEventsDelta).toHaveBeenCalledTimes(1);
    expect(calls.applied[0]!.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(calls.applied[0]!.complete).toBe(false);
    expect(calls.applied[0]!.cursor).toBeNull();

    // A new delta round over the cap is not complete either (no cancellations from a truncated list).
    const fresh = makeRepo([{ id: C1, provider: 'outlook', s: secrets() }]);
    await runCalendarSyncSweep({
      repo: fresh.repo,
      providers: { outlook: provider({ listEventsDelta }) },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
      config: { maxEvents: 3, deltaEnabled: true },
    });
    expect(fresh.calls.applied[0]!.events).toHaveLength(3);
    expect(fresh.calls.applied[0]!.complete).toBe(false);
    expect(fresh.calls.applied[0]!.cursor).toBeNull();

    // Under the cap the delta page is untouched.
    const small = makeRepo([{ id: C1, provider: 'outlook', s: secrets({ syncCursor: cursor }) }]);
    await runCalendarSyncSweep({
      repo: small.repo,
      providers: { outlook: provider({ listEventsDelta }) },
      log: log(),
      now: () => NOW,
      random: () => 0.5,
      config: { maxEvents: 10, deltaEnabled: true, cursorMaxLagMs: 365 * DAY },
    });
    expect(small.calls.applied[0]!.events).toHaveLength(5);
    expect(small.calls.applied[0]!.cursor).toBe('cur-2');
  });
});
