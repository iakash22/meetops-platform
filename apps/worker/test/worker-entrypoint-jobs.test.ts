import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  closeAll,
  loadTokenRefreshEnv,
  registerSummaryWorker,
  registerTokenRefreshJob,
  registerTranscriptionWorker,
  runningJobs,
  TokenRefreshEnvError,
  tokenRefreshProvidersFromEnv,
  type ClosableJob,
} from '../src/index.js';

const log = { info: vi.fn(), warn: vi.fn() };
const kek = randomBytes(32).toString('base64');
const fakeRepo = {
  listDueForRefresh: vi.fn(async () => []),
  get: vi.fn(),
  readSecrets: vi.fn(),
  upsert: vi.fn(),
  setStatus: vi.fn(),
};

describe('integrations token-refresh env', () => {
  it('is off by default and needs no key', () => {
    expect(loadTokenRefreshEnv({})).toEqual({ enabled: false, intervalMs: 300_000 });
  });
  it('fails closed when enabled without a 32-byte KEK, naming the key only', () => {
    expect(() => loadTokenRefreshEnv({ INTEGRATIONS_TOKEN_REFRESH_ENABLED: 'true' })).toThrow(
      TokenRefreshEnvError,
    );
    const short = Buffer.from('too-short').toString('base64');
    expect(() =>
      loadTokenRefreshEnv({
        INTEGRATIONS_TOKEN_REFRESH_ENABLED: 'true',
        INTEGRATIONS_TOKEN_KEK: short,
      }),
    ).toThrow(/INTEGRATIONS_TOKEN_KEK/);
    try {
      loadTokenRefreshEnv({
        INTEGRATIONS_TOKEN_REFRESH_ENABLED: 'true',
        INTEGRATIONS_TOKEN_KEK: short,
      });
    } catch (e) {
      expect(String(e)).not.toContain(short);
    }
  });
  it('refuses the dev KEK when NODE_ENV=production, even with refresh off (ADR-008)', () => {
    for (const enabled of ['true', 'false'])
      expect(() =>
        loadTokenRefreshEnv({
          NODE_ENV: 'production',
          INTEGRATIONS_TOKEN_REFRESH_ENABLED: enabled,
          INTEGRATIONS_TOKEN_KEK: kek,
        }),
      ).toThrow(/INTEGRATIONS_TOKEN_KEK.*production/);
  });
  it('rejects non-canonical base64 KEKs without echoing the value', () => {
    const bad = [
      kek.replace(/=$/, ''),
      randomBytes(32).toString('base64url') + '=',
      randomBytes(32).toString('base64').replace(/.=$/, 'B='),
    ];
    for (const value of bad) {
      let msg = '';
      try {
        loadTokenRefreshEnv({ INTEGRATIONS_TOKEN_KEK: value });
      } catch (e) {
        expect(e).toBeInstanceOf(TokenRefreshEnvError);
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/INTEGRATIONS_TOKEN_KEK/);
      expect(msg).not.toContain(value);
    }
  });
  it('rejects out-of-range intervals', () => {
    expect(() => loadTokenRefreshEnv({ INTEGRATIONS_TOKEN_REFRESH_INTERVAL_MS: '5' })).toThrow();
  });
  it('builds only configured providers (no fallback)', () => {
    expect(tokenRefreshProvidersFromEnv({})).toEqual({});
    const p = tokenRefreshProvidersFromEnv({ JIRA_CLIENT_ID: 'id', JIRA_CLIENT_SECRET: 's' });
    expect(p.jira).toBeDefined();
    expect(p.github).toBeUndefined();
  });
});

describe('integrations token-refresh job registration', () => {
  it('is not registered when disabled', () => {
    const start = vi.fn();
    const r = registerTokenRefreshJob({ env: loadTokenRefreshEnv({}), log, start });
    expect(r.registered).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('registers, sweeps, and is closed by graceful shutdown', async () => {
    const env = loadTokenRefreshEnv({
      INTEGRATIONS_TOKEN_REFRESH_ENABLED: 'true',
      INTEGRATIONS_TOKEN_KEK: kek,
      INTEGRATIONS_TOKEN_REFRESH_INTERVAL_MS: '60000',
    });
    const r = registerTokenRefreshJob({
      env,
      log,
      buildDeps: () => ({ repo: fakeRepo, providers: {} }),
    });
    expect(r.registered).toBe(true);
    if (!r.registered) return;
    await r.tick();
    expect(fakeRepo.listDueForRefresh).toHaveBeenCalledTimes(1);
    const close = vi.spyOn(r, 'close');
    const closed = await closeAll([{ name: 'integrations-token-refresh', job: r }]);
    expect(closed).toEqual(['integrations-token-refresh']);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('AI workers from the entrypoint', () => {
  it('transcription + summary are registered when flagged on and closed on shutdown', async () => {
    const tClose = vi.fn(async () => undefined);
    const sClose = vi.fn(async () => undefined);
    const transcription = registerTranscriptionWorker({
      env: { enabled: true, concurrency: 1, segmentSeconds: 60, redisUrl: 'redis://x' },
      resolveDeps: () => ({}) as never,
      start: (() => ({ worker: {}, close: tClose })) as never,
      logger: log,
    });
    const summary = registerSummaryWorker({
      env: {
        enabled: true,
        concurrency: 1,
        redisUrl: 'redis://x',
        actionItemsEnabled: false,
      },
      resolveExecutor: () => ({}) as never,
      deps: () => ({}) as never,
      start: (() => ({ close: sClose })) as never,
      logger: log,
    });
    expect(transcription.registered).toBe(true);
    expect(summary.registered).toBe(true);
    const jobs: ClosableJob[] = [
      { name: 'transcription', job: transcription },
      { name: 'summary', job: summary },
    ];
    expect(runningJobs(jobs)).toEqual(['transcription', 'summary']);
    await closeAll(jobs);
    expect(tClose).toHaveBeenCalledTimes(1);
    expect(sClose).toHaveBeenCalledTimes(1);
  });

  it('stay unregistered with flags off (defaults unchanged)', () => {
    const t = registerTranscriptionWorker({
      env: { enabled: false, concurrency: 1, segmentSeconds: 60, redisUrl: 'redis://x' },
      logger: log,
    });
    const s = registerSummaryWorker({
      env: {
        enabled: false,
        concurrency: 1,
        redisUrl: 'redis://x',
        actionItemsEnabled: false,
      },
      logger: log,
    });
    expect(
      runningJobs([
        { name: 't', job: t },
        { name: 's', job: s },
      ]),
    ).toEqual([]);
  });
});

describe('closeAll', () => {
  it('closes every running job even when one fails, and skips jobs that never started', async () => {
    const ok = vi.fn(async () => undefined);
    const bad = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const closed = await closeAll(
      [
        { name: 'a', close: bad },
        { name: 'b', close: ok },
        { name: 'c', close: undefined },
        { name: 'd', job: { registered: false } },
      ],
      { warn },
    );
    expect(closed).toEqual(['a', 'b']);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ job: 'a', errName: 'Error' }, 'worker job close failed');
  });
});

describe('calendar-sync in the worker shutdown path', () => {
  it('main() registers calendar-sync before building the jobs list and includes it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const reg = src.indexOf('const calendarSync = registerCalendarSyncScheduler(');
    const jobs = src.indexOf('const jobs: ClosableJob[] = [');
    const entry = src.indexOf("{ name: 'calendar-sync', job: calendarSync }");
    const end = src.indexOf('];', jobs);
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(jobs);
    expect(entry).toBeGreaterThan(jobs);
    expect(entry).toBeLessThan(end);
  });

  it('closeAll waits for the calendar-sync worker (in-flight sweep) and closes its queue', async () => {
    const { registerCalendarSyncScheduler, loadCalendarSyncEnv } =
      await import('../src/calendar/index.js');
    let finishSweep!: () => void;
    const order: string[] = [];
    const worker = {
      close: vi.fn(
        () =>
          new Promise<void>((r) => {
            finishSweep = () => {
              order.push('worker');
              r();
            };
          }),
      ),
    };
    const queue = {
      upsertJobScheduler: vi.fn(async () => undefined),
      close: vi.fn(async () => void order.push('queue')),
    };
    const calendarSync = registerCalendarSyncScheduler({
      env: loadCalendarSyncEnv({ CALENDAR_SYNC_ENABLED: 'true' }),
      log,
      processEnv: { INTEGRATIONS_TOKEN_KEK: kek },
      buildDeps: () => ({ repo: {} as never, providers: {} }),
      createQueue: () => queue,
      createWorker: () => worker,
    });
    const jobs: ClosableJob[] = [{ name: 'calendar-sync', job: calendarSync }];
    expect(runningJobs(jobs)).toEqual(['calendar-sync']);
    const done = closeAll(jobs);
    await vi.waitFor(() => expect(worker.close).toHaveBeenCalled());
    expect(queue.close).not.toHaveBeenCalled();
    finishSweep();
    await expect(done).resolves.toEqual(['calendar-sync']);
    expect(order).toEqual(['worker', 'queue']);
  });
});
