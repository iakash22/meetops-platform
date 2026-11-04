import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  CONFIRM_LEASE_LUA,
  RELEASE_LEASE_LUA,
  createRedisConnectionLease,
  tokenRefreshLeaseKey,
} from '../src/token-refresh-lease.js';

/**
 * #378 M2: the lease Lua scripts against a real Redis (ioredis-mock does not run Lua faithfully). Opt-in: skipped
 * unless REDIS_URL is set, e.g. `REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @meetops/integrations test`.
 * Uses a random key prefix and deletes only its own keys.
 */
const url = process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)('token refresh lease on real Redis (REDIS_URL)', () => {
  let redis: Redis;
  const prefix = `test:lease:${randomUUID()}:`;
  const k = (s: string) => prefix + s;
  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1, lazyConnect: false });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('acquire is SET NX PX: one owner, with the TTL set', async () => {
    const lease = createRedisConnectionLease(redis);
    const key = k('acquire');
    const a = await lease.acquire(key, 5_000);
    expect(a).toEqual(expect.any(String));
    expect(await lease.acquire(key, 5_000)).toBeNull();
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it('only one of many concurrent acquires wins', async () => {
    const lease = createRedisConnectionLease(redis);
    const key = k('race');
    const got = await Promise.all(Array.from({ length: 20 }, () => lease.acquire(key, 5_000)));
    expect(got.filter((t) => t !== null)).toHaveLength(1);
  });

  it('CONFIRM_LEASE_LUA renews only for the owner', async () => {
    const lease = createRedisConnectionLease(redis);
    const key = k('confirm');
    const t = (await lease.acquire(key, 1_000))!;
    expect(await lease.confirm(key, 'not-the-owner', 60_000)).toBe(false);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(1_000);
    expect(await lease.confirm(key, t, 60_000)).toBe(true);
    expect(await redis.pttl(key)).toBeGreaterThan(1_000);
    expect(Number(await redis.eval(CONFIRM_LEASE_LUA, 1, k('missing'), t, '1000'))).toBe(0);
  });

  it('RELEASE_LEASE_LUA deletes only the owner’s lease', async () => {
    const lease = createRedisConnectionLease(redis);
    const key = k('release');
    const t = (await lease.acquire(key, 5_000))!;
    expect(await lease.release(key, 'not-the-owner')).toBe(false);
    expect(await redis.get(key)).toBe(t);
    expect(await lease.release(key, t)).toBe(true);
    expect(await redis.exists(key)).toBe(0);
    expect(Number(await redis.eval(RELEASE_LEASE_LUA, 1, key, t))).toBe(0);
  });

  it('an expired lease can be re-taken, and the old holder can neither confirm nor release it', async () => {
    const lease = createRedisConnectionLease(redis);
    const key = k(tokenRefreshLeaseKey(randomUUID(), randomUUID()));
    const old = (await lease.acquire(key, 50))!;
    await sleep(120);
    const next = (await lease.acquire(key, 5_000))!;
    expect(next).not.toBe(old);
    expect(await lease.confirm(key, old, 5_000)).toBe(false);
    expect(await lease.release(key, old)).toBe(false);
    expect(await redis.get(key)).toBe(next);
  });
});
