import type { Clock } from '../../../../shared/ports.js';
import type { LoginLockout, RateLimiter } from '../../domain/ports.js';

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

export interface LockoutPolicy {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}
export const DEFAULT_LOCKOUT: LockoutPolicy = { maxFailures: 10, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

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
    if (s.failures >= this.policy.maxFailures) s.lockedUntil = now + this.policy.lockMs;
    this.state.set(key, s);
  }
  async reset(key: string) {
    this.state.delete(key);
  }
}
