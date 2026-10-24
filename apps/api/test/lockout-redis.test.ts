import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, Client, PASSWORD, signupAndLogin, type App } from './helpers.js';
import { fakeRedis } from './fake-redis.js';
import {
  INCR_WITH_EXPIRY_LUA,
  RedisLoginLockout,
  RedisRateLimiter
} from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import { InMemoryLoginLockout } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import { defaultModuleDeps, MissingProductionDependencyError } from '../src/modules/index.js';

/** Wraps a fake client and records every command name, to prove counters use one atomic EVAL. */
function spyRedis() {
  const inner = fakeRedis();
  const calls: string[] = [];
  const r = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== 'function' || prop === 'advance') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
  });
  return { r, calls };
}

describe('Redis counters are atomic (INCR + PEXPIRE in one script)', () => {
  it('script sets the expiry with the first INCR and self-heals a TTL-less key', () => {
    expect(INCR_WITH_EXPIRY_LUA).toMatch(/INCR/);
    expect(INCR_WITH_EXPIRY_LUA).toMatch(/PEXPIRE/);
    expect(INCR_WITH_EXPIRY_LUA).toMatch(/n == 1/);
  });

  it('RedisLoginLockout.recordFailure never issues a separate INCR/PEXPIRE', async () => {
    const { r, calls } = spyRedis();
    const lo = new RedisLoginLockout(r);
    await lo.recordFailure('a@example.test');
    expect(calls).toEqual(['eval']);
    expect(await r.pttl('meetops:lock:fail:a@example.test')).toBeGreaterThan(0);
  });

  it('RedisRateLimiter.consume uses one EVAL per hit, with TTL set from the first hit', async () => {
    const { r, calls } = spyRedis();
    const rl = new RedisRateLimiter(r);
    await rl.consume('k', 1, 1000);
    const blocked = await rl.consume('k', 1, 1000);
    expect(calls).toEqual(['eval', 'eval']);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });
});

describe('lockout wiring (modules/index.ts)', () => {
  it('uses RedisLoginLockout when a Redis client is injected', () => {
    const deps = defaultModuleDeps({ redis: fakeRedis() }, { nodeEnv: 'test' });
    expect(deps.lockout).toBeInstanceOf(RedisLoginLockout);
  });

  it('falls back to in-memory in test/development without Redis', () => {
    expect(defaultModuleDeps({}, { nodeEnv: 'test' }).lockout).toBeInstanceOf(InMemoryLoginLockout);
    expect(defaultModuleDeps({}, { nodeEnv: 'development' }).lockout).toBeInstanceOf(InMemoryLoginLockout);
  });

  it('ignores REDIS_URL under NODE_ENV=test (hermetic tests)', () => {
    const deps = defaultModuleDeps({}, { nodeEnv: 'test', redisUrl: 'redis://localhost:1' });
    expect(deps.lockout).toBeInstanceOf(InMemoryLoginLockout);
  });

  it('fails closed outside development/test when neither Redis nor a lockout is provided', () => {
    let err: unknown;
    try {
      defaultModuleDeps({}, { nodeEnv: 'production' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingProductionDependencyError);
    expect((err as MissingProductionDependencyError).missing).toContain('lockout');
  });

  it('a Redis client satisfies the production lockout requirement', () => {
    let err: unknown;
    try {
      defaultModuleDeps({ redis: fakeRedis() }, { nodeEnv: 'production' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingProductionDependencyError);
    expect((err as MissingProductionDependencyError).missing).not.toContain('lockout');
  });

  it('an explicitly injected lockout wins over Redis', () => {
    const lockout = new InMemoryLoginLockout({ now: () => new Date() });
    expect(defaultModuleDeps({ lockout, redis: fakeRedis() }, { nodeEnv: 'test' }).lockout).toBe(lockout);
  });
});

describe('lockout notice email (spec §5)', () => {
  let apps: App[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps = [];
  });

  async function failTimes(app: App, email: string, n: number) {
    const c = new Client(app);
    const res = [];
    for (let i = 0; i < n; i++) res.push(await c.post('/auth/login', { email, password: 'wrong-password-x' }));
    return res;
  }

  it('sends exactly one lockout notice to an existing account on the 10th failure', async () => {
    const app = await buildApp({ sleep: async () => {}, redis: fakeRedis() });
    apps.push(app);
    await signupAndLogin(app, 'owner@example.test');
    await failTimes(app, 'owner@example.test', 9);
    expect(app.mail.sent.filter((m) => m.template === 'login_lockout')).toHaveLength(0);
    await failTimes(app, 'owner@example.test', 1);
    const notices = app.mail.sent.filter((m) => m.template === 'login_lockout');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.to).toBe('owner@example.test');
    expect(notices[0]?.data.url).toMatch(/\/forgot-password$/);
    const locked = await new Client(app).post('/auth/login', { email: 'owner@example.test', password: PASSWORD });
    expect(locked.statusCode).toBe(429);
  });

  it('unknown email: no mail, but identical responses and the same queued job shape', async () => {
    const known = await buildApp({ sleep: async () => {} });
    const ghost = await buildApp({ sleep: async () => {} });
    apps.push(known, ghost);
    await signupAndLogin(known, 'real@example.test');
    const before = known.mail.sent.length;
    const a = await failTimes(known, 'real@example.test', 10);
    const b = await failTimes(ghost, 'nobody@example.test', 10);
    const shape = (r: (typeof a)[number]) => [r.statusCode, JSON.stringify(r.json().error?.code ?? r.json().code)];
    expect(a.map(shape)).toEqual(b.map(shape));
    expect(known.mail.sent.length - before).toBe(1);
    expect(ghost.mail.sent).toHaveLength(0);
  });
});
