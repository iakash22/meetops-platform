import type { Clock } from '../../../../shared/ports.js';
import type { LoginLockout, RateLimiter } from '../../domain/ports.js';
import { DEFAULT_LOCKOUT, lockDurationMs, type LockoutPolicy } from './lockout-policy.js';

export { DEFAULT_LOCKOUT, type LockoutPolicy };

/** Test/dev only: process-local fixed windows. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly clock: Clock) {}
  async consume(key: string, limit: number, windowMs: number) {
    const now = this.clock.now().getTime();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count <= limit ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: b.resetAt - now };
  }
}

/** Test/dev only. Same progressive policy as RedisLoginLockout. */
export class InMemoryLoginLockout implements LoginLockout {
  private readonly state = new Map<string, { failures: number; windowEnd: number; lockedUntil: number }>();
  constructor(
    private readonly clock: Clock,
    private readonly policy: LockoutPolicy = DEFAULT_LOCKOUT
  ) {}
  async isLocked(key: string) {
    const now = this.clock.now().getTime();
    const s = this.state.get(key);
    return s && s.lockedUntil > now ? { locked: true, retryAfterMs: s.lockedUntil - now } : { locked: false, retryAfterMs: 0 };
  }
  async recordFailure(key: string) {
    const now = this.clock.now().getTime();
    let s = this.state.get(key);
    if (!s || s.windowEnd <= now) s = { failures: 0, windowEnd: now + this.policy.windowMs, lockedUntil: 0 };
    s.failures++;
    const lockedForMs = lockDurationMs(s.failures, this.policy);
    if (lockedForMs) {
      s.lockedUntil = now + lockedForMs;
      // keep the failure count alive at least as long as the lock
      s.windowEnd = Math.max(s.windowEnd, s.lockedUntil + this.policy.windowMs);
    }
    this.state.set(key, s);
    return { lockedForMs };
  }
  async reset(key: string) {
    this.state.delete(key);
  }
}
