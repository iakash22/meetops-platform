import type { LoginLockout, RateLimiter } from '../../domain/ports.js';
import {
  DEFAULT_LOCKOUT,
  failureDelayMs,
  lockDurationMs,
  type LockoutPolicy,
} from './lockout-policy.js';

/** Minimal subset of an ioredis client (keeps tests on a fake). */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  /** SET ... PX ms NX: resolves 'OK' when set, null when the key already exists. */
  set(key: string, value: string, mode: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  /** EVAL (ioredis signature): script, number of keys, then keys and args. */
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
  /** PUBLISH (ADR-011 revocation fan-out). Optional so lockout-only fakes stay valid. */
  publish?(channel: string, message: string): Promise<number>;
}

/**
 * INCR and, on the first hit (or if the key somehow lost its TTL), PEXPIRE in one Lua script,
 * so the counter can never be left without an expiry (e.g. process crash between commands).
 * Returns [count, pttl].
 */
export const INCR_WITH_EXPIRY_LUA = `local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}`;

export async function incrWithExpiry(
  redis: RedisLike,
  key: string,
  windowMs: number,
): Promise<{ count: number; ttlMs: number }> {
  const r = (await redis.eval(INCR_WITH_EXPIRY_LUA, 1, key, String(windowMs))) as [
    number | string,
    number | string,
  ];
  return { count: Number(r[0]), ttlMs: Number(r[1]) };
}

/** Fixed window: atomic INCR + PEXPIRE on first hit (Lua). */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'meetops:rl:',
  ) {}
  async consume(key: string, limit: number, windowMs: number) {
    const k = this.prefix + key;
    const { count, ttlMs } = await incrWithExpiry(this.redis, k, windowMs);
    if (count <= limit) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: ttlMs > 0 ? ttlMs : windowMs };
  }
}

/** Login lockout (see lockout-policy.ts), shared across API instances. */
export class RedisLoginLockout implements LoginLockout {
  constructor(
    private readonly redis: RedisLike,
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT,
    private readonly prefix = 'meetops:lock:',
  ) {}
  async isLocked(key: string) {
    const ttl = await this.redis.pttl(`${this.prefix}locked:${key}`);
    return ttl > 0 ? { locked: true, retryAfterMs: ttl } : { locked: false, retryAfterMs: 0 };
  }
  async recordFailure(key: string) {
    const k = `${this.prefix}fail:${key}`;
    const { count: n } = await incrWithExpiry(this.redis, k, this.policy.windowMs);
    const delayMs = failureDelayMs(n, this.policy);
    const lockedForMs = lockDurationMs(n, this.policy);
    if (lockedForMs) {
      await this.redis.set(`${this.prefix}locked:${key}`, '1', 'PX', lockedForMs);
      await this.redis.del(k);
    }
    return { lockedForMs, delayMs };
  }
  async reset(key: string) {
    await this.redis.del(`${this.prefix}fail:${key}`, `${this.prefix}locked:${key}`);
  }
}
