import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createRedisConnectionLease } from '@meetops/integrations';
import { ACQUIRE_LEASE_LUA, leaseRedisFromEval } from '../src/modules/integrations/runtime.js';

/**
 * #378 M2: the API's eval-only lease adapter (ACQUIRE_LEASE_LUA = SET NX PX in Lua) against a real Redis. Opt-in:
 * skipped unless REDIS_URL is set. Random key prefix; deletes only its own keys.
 */
const url = process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)('API token refresh lease adapter on real Redis (REDIS_URL)', () => {
  let redis: Redis;
  const prefix = `test:api-lease:${randomUUID()}:`;
  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('ACQUIRE_LEASE_LUA returns OK once, nil while held, and sets the PX TTL', async () => {
    const key = `${prefix}acq`;
    expect(await redis.eval(ACQUIRE_LEASE_LUA, 1, key, 'a', '5000')).toBe('OK');
    expect(await redis.eval(ACQUIRE_LEASE_LUA, 1, key, 'b', '5000')).toBeNull();
    expect(await redis.get(key)).toBe('a');
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('the full lease through leaseRedisFromEval: exclusive, owner-only confirm/release, expiry', async () => {
    const lease = createRedisConnectionLease(leaseRedisFromEval(redis));
    const key = `${prefix}full`;
    const got = await Promise.all(Array.from({ length: 10 }, () => lease.acquire(key, 80)));
    const owner = got.find((t) => t !== null)!;
    expect(got.filter((t) => t !== null)).toHaveLength(1);
    expect(await lease.confirm(key, 'other', 80)).toBe(false);
    expect(await lease.confirm(key, owner, 80)).toBe(true);
    await sleep(160);
    const next = (await lease.acquire(key, 5_000))!;
    expect(next).toEqual(expect.any(String));
    expect(await lease.release(key, owner)).toBe(false);
    expect(await lease.release(key, next)).toBe(true);
  });
});
