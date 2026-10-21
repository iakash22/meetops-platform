/**
 * Progressive lockout: after `threshold` failures inside `windowMs`, lock for baseLockMs,
 * doubling with every further failure, capped at maxLockMs. Never permanent.
 */
export interface LockoutPolicy {
  threshold: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}
const MIN = 60_000;
export const DEFAULT_LOCKOUT: LockoutPolicy = { threshold: 5, windowMs: 15 * MIN, baseLockMs: MIN, maxLockMs: 60 * MIN };

/** 0 = not locked. */
export function lockDurationMs(failures: number, p: LockoutPolicy): number {
  if (failures < p.threshold) return 0;
  return Math.min(p.baseLockMs * 2 ** (failures - p.threshold), p.maxLockMs);
}
