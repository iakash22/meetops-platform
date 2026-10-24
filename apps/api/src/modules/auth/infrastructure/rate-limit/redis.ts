import type { LoginLockout, RateLimiter } from '../../domain/ports.js';
import { DEFAULT_LOCKOUT, failureDelayMs, lockDurationMs, type LockoutPolicy } from './lockout-policy.js';

/** Minimal subset of an ioredis client (keeps tests on a fake). */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

/** Fixed window: INCR + PEXPIRE on first hit. */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'meetops:rl:'
  ) {}
  async consume(key: string, limit: number, windowMs: number) {
    const k = this.prefix + key;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    if (count <= limit) return { allowed: true, retryAfterMs: 0 };
    const ttl = await this.redis.pttl(k);
    if (ttl < 0) await this.redis.pexpire(k, windowMs); // self-heal a key that lost its TTL
    return { allowed: false, retryAfterMs: ttl > 0 ? ttl : windowMs };
  }
}

/** Login lockout (see lockout-policy.ts), shared across API instances. */
export class RedisLoginLockout implements LoginLockout {
  constructor(
    private readonly redis: RedisLike,
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT,
    private readonly prefix = 'meetops:lock:'
  ) {}
  async isLocked(key: string) {
    const ttl = await this.redis.pttl(`${this.prefix}locked:${key}`);
    return ttl > 0 ? { locked: true, retryAfterMs: ttl } : { locked: false, retryAfterMs: 0 };
  }
  async recordFailure(key: string) {
    const k = `${this.prefix}fail:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.pexpire(k, this.policy.windowMs);
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
