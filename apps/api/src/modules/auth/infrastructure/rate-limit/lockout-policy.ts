/**
 * Login lockout per docs/12-security/auth-session-spec.md §5 (Login row):
 * "5 failures / 15 min → progressive delay; 10 → temporary lock 15 min + email notice".
 *
 * - failures 1..delayThreshold-1: no delay, no lock
 * - failures delayThreshold..lockThreshold-1: progressive delay (baseDelayMs doubling, capped
 *   at maxDelayMs); the response is still the generic 401
 * - failure lockThreshold: temporary lock of lockMs (fixed, never permanent); the count restarts
 *   once the lock is applied
 */
export interface LockoutPolicy {
  windowMs: number;
  delayThreshold: number;
  lockThreshold: number;
  baseDelayMs: number;
  maxDelayMs: number;
  lockMs: number;
}
const MIN = 60_000;
export const DEFAULT_LOCKOUT: LockoutPolicy = {
  windowMs: 15 * MIN,
  delayThreshold: 5,
  lockThreshold: 10,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  lockMs: 15 * MIN,
};

/** Delay to apply to the response of the n-th failure in the window (0 = none). */
export function failureDelayMs(failures: number, p: LockoutPolicy): number {
  if (failures < p.delayThreshold || failures >= p.lockThreshold) return 0;
  return Math.min(p.baseDelayMs * 2 ** (failures - p.delayThreshold), p.maxDelayMs);
}

/** Lock started by the n-th failure in the window (0 = none). */
export function lockDurationMs(failures: number, p: LockoutPolicy): number {
  return failures >= p.lockThreshold ? p.lockMs : 0;
}
