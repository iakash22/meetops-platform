import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import {
  createReadiness,
  defaultReadinessChecks,
  DEFAULT_READINESS_TIMEOUT_MS,
  readinessTimeoutFromEnv,
} from '../src/shared/readiness.js';

const SECRET_URL = 'postgres://meetops:hunter2-secret@db.internal:5432/meetops';
const apps: Array<ReturnType<typeof createServer>> = [];
const server = (opts: Parameters<typeof createServer>[0]) => {
  const app = createServer({ nodeEnv: 'test', databaseUrl: '', redisUrl: '', ...opts });
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('GET /ready', () => {
  it('stays { status: ready } when the process has no external dependencies', async () => {
    const res = await server({}).inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('200 with per-check outcomes when every probe passes', async () => {
    const app = server({
      readinessChecks: [
        { name: 'database', probe: async () => 1 },
        { name: 'redis', probe: async () => 'PONG' },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
  });

  it('503 naming the failed check, without leaking the error text', async () => {
    const app = server({
      readinessChecks: [
        {
          name: 'database',
          probe: async () => Promise.reject(new Error(`connect ECONNREFUSED ${SECRET_URL}`)),
        },
        { name: 'redis', probe: async () => 'PONG' },
      ],
    });
    const warn = vi.spyOn(app.log, 'warn');
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { database: 'fail', redis: 'ok' } });
    expect(res.body).not.toContain('hunter2');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
    expect(warn).toHaveBeenCalledWith(
      { readiness: { database: 'fail', redis: 'ok' } },
      'readiness check failed',
    );
  });

  it('503 timeout when a probe hangs past the per-probe timeout', async () => {
    const app = server({
      readinessTimeoutMs: 20,
      readinessChecks: [{ name: 'redis', probe: () => new Promise(() => {}) }],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { redis: 'timeout' } });
  });

  it('a synchronous throw in a probe is a fail, not a 500', async () => {
    const app = server({
      readinessChecks: [
        {
          name: 'database',
          probe: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { database: 'fail' } });
  });

  it('/health stays dependency-free even when readiness fails', async () => {
    const probe = vi.fn(async () => Promise.reject(new Error('down')));
    const app = server({ readinessChecks: [{ name: 'database', probe }] });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('createReadiness', () => {
  it('coalesces concurrent checks into one probe run, then re-probes', async () => {
    let release!: () => void;
    const probe = vi.fn(() => new Promise<void>((r) => (release = r)));
    const r = createReadiness([{ name: 'database', probe }], 1000);
    const a = r.check();
    const b = r.check();
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { ready: true, checks: { database: 'ok' } },
      { ready: true, checks: { database: 'ok' } },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    const c = r.check();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    release();
    await c;
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('defaultReadinessChecks', () => {
  it('SELECT 1 on Prisma and PING on Redis; skips absent clients', async () => {
    const queryRaw = vi.fn(async (q: TemplateStringsArray) => q.join(''));
    const ping = vi.fn(async () => 'PONG');
    const checks = defaultReadinessChecks({ db: { $queryRaw: queryRaw }, redis: { ping } });
    expect(checks.map((c) => c.name)).toEqual(['database', 'redis']);
    await Promise.all(checks.map((c) => c.probe()));
    expect(queryRaw.mock.calls[0]![0].join('')).toBe('SELECT 1');
    expect(ping).toHaveBeenCalledOnce();
    expect(defaultReadinessChecks({})).toEqual([]);
    expect(defaultReadinessChecks({ redis: { get: async () => null } })).toEqual([]);
  });
});

describe('readinessTimeoutFromEnv', () => {
  it.each([
    [undefined, DEFAULT_READINESS_TIMEOUT_MS],
    ['', DEFAULT_READINESS_TIMEOUT_MS],
    ['500', 500],
    ['99', DEFAULT_READINESS_TIMEOUT_MS],
    ['30001', DEFAULT_READINESS_TIMEOUT_MS],
    ['1e3', DEFAULT_READINESS_TIMEOUT_MS],
  ])('%s -> %s', (v, want) => expect(readinessTimeoutFromEnv(v)).toBe(want));
});
