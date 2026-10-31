import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  closeAll,
  loadTokenRefreshEnv,
  registerSummaryWorker,
  registerTokenRefreshJob,
  startTokenRefreshQueueScheduler,
  TOKEN_REFRESH_SCHEDULER_ID,
  type TokenRefreshQueueFactories,
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

function fakeFactories() {
  const upserts: Array<{ id: string; every: number }> = [];
  const processors: Array<() => Promise<unknown>> = [];
  const closed: string[] = [];
  const factories: TokenRefreshQueueFactories = {
    queue: () => ({
      upsertJobScheduler: vi.fn(async (id: string, repeat: { every: number }) => {
        upserts.push({ id, every: repeat.every });
      }),
      close: vi.fn(async () => void closed.push('queue')),
    }),
    worker: (p) => {
      processors.push(p);
      return { close: vi.fn(async () => void closed.push('worker')) };
    },
  };
  return { factories, upserts, processors, closed };
}

describe('integrations token refresh runs on a single replica (BullMQ job scheduler)', () => {
  it('every replica upserts the same scheduler id, so Redis holds one repeatable job', async () => {
    const f = fakeFactories();
    const deps = { repo: fakeRepo, providers: {}, log };
    const a = startTokenRefreshQueueScheduler(deps, { intervalMs: 60_000, factories: f.factories });
    const b = startTokenRefreshQueueScheduler(deps, { intervalMs: 60_000, factories: f.factories });
    await Promise.resolve();
    expect(f.upserts).toEqual([
      { id: TOKEN_REFRESH_SCHEDULER_ID, every: 60_000 },
      { id: TOKEN_REFRESH_SCHEDULER_ID, every: 60_000 },
    ]);
    expect(new Set(f.upserts.map((u) => u.id)).size).toBe(1);
    // No per-process timer: a sweep only runs when BullMQ hands this replica the job.
    fakeRepo.listDueForRefresh.mockClear();
    await f.processors[0]!();
    expect(fakeRepo.listDueForRefresh).toHaveBeenCalledTimes(1);
    await a.close();
    await b.close();
    expect(f.closed).toEqual(['worker', 'queue', 'worker', 'queue']);
  });

  it('does not start an in-process interval', () => {
    vi.useFakeTimers();
    try {
      const f = fakeFactories();
      fakeRepo.listDueForRefresh.mockClear();
      startTokenRefreshQueueScheduler(
        { repo: fakeRepo, providers: {}, log },
        { intervalMs: 30_000, factories: f.factories },
      );
      vi.advanceTimersByTime(120_000);
      expect(fakeRepo.listDueForRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs only the error name when a sweep fails, and rethrows so BullMQ records it', async () => {
    const f = fakeFactories();
    const warn = vi.fn();
    const repo = {
      ...fakeRepo,
      listDueForRefresh: vi.fn(async () => Promise.reject(new TypeError('x'))),
    };
    startTokenRefreshQueueScheduler(
      { repo, providers: {}, log: { info: vi.fn(), warn } },
      { intervalMs: 60_000, factories: f.factories },
    );
    await expect(f.processors[0]!()).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith({ errName: 'TypeError' }, expect.any(String));
  });
});

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
      start: (deps, o) =>
        startTokenRefreshQueueScheduler(deps, { ...o, factories: fakeFactories().factories }),
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
