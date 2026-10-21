import type { LoginLockout, RateLimiter } from '../../domain/ports.js';
import { DEFAULT_LOCKOUT, type LockoutPolicy } from './in-memory.js';

/** Minimal subset of an ioredis client, so no new dependency is needed here. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'rl:'
  ) {}
  async consume(key: string, limit: number, windowMs: number) {
    const k = this.prefix + key;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    if (count <= limit) return { allowed: true, retryAfterMs: 0 };
    const ttl = await this.redis.pttl(k);
    return { allowed: false, retryAfterMs: ttl > 0 ? ttl : windowMs };
  }
}

export class RedisLoginLockout implements LoginLockout {
  constructor(
    private readonly redis: RedisLike,
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT,
    private readonly prefix = 'lock:'
  ) {}
  async isLocked(key: string) {
    const ttl = await this.redis.pttl(`${this.prefix}locked:${key}`);
    return ttl > 0 ? { locked: true, retryAfterMs: ttl } : { locked: false, retryAfterMs: 0 };
  }
  async recordFailure(key: string) {
    const k = `${this.prefix}fail:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.pexpire(k, this.policy.windowMs);
    if (n >= this.policy.maxFailures) await this.redis.set(`${this.prefix}locked:${key}`, '1', 'PX', this.policy.lockMs);
  }
  async reset(key: string) {
    await this.redis.del(`${this.prefix}fail:${key}`);
  }
}
