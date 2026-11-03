import type { RateLimiter } from '../../auth/domain/ports.js';
import { RateLimitedError } from '../../auth/domain/errors.js';
import type { DirectoryCaller } from '../../directory/access.js';
import { DomainError } from '../../../shared/domain-error.js';

export type MediaLimit = { limit: number; windowMs: number };

export type MediaRateLimits = {
  /** Chunk upload-URL presigns, per org + user + recording session + IP. Charged only after the ownership check. */
  chunkPerSessionIp: MediaLimit;
  /** Chunk upload-URL presigns, per authenticated user + client IP (all of that user's sessions). */
  chunkPerUserIp: MediaLimit;
  /** Chunk upload-URL presigns, per authenticated user across all IPs (rotating IPs cannot get around it). */
  chunkPerUser: MediaLimit;
  /**
   * Upload init/complete and recording-session init/complete/abort, per user + IP. Shared by cookie (web) and
   * ADR-005 bearer (extension, desktop) callers, which reach the same routes.
   */
  controlPerUserIp: MediaLimit;
  /** Same routes as controlPerUserIp, per user across all IPs. */
  controlPerUser: MediaLimit;
};

/**
 * Sizing (full reasoning in docs/p9/media-rate-limits.md):
 * - Live cadence: the extension records 5 s timeslices (TIMESLICE_MS), splitting a slice into <= 8 MiB seqs only when
 *   it is oversized; desktop records 10 s timeslices. So one session presigns ~6 chunks per 30 s, ~12 in the worst
 *   split case. 150 / 30 s per session is >= 12x that, and leaves room to drain an offline backlog at 5 presigns/s.
 * - Per user + IP: 300 / 30 s (10/s) covers two sessions on one network draining at full speed.
 * - Per user, any IP: 450 / 30 s (15/s) covers three sessions draining at full speed from different networks
 *   (extension + desktop + a retry from a new IP); IP rotation cannot raise a user above it.
 * - 30 s windows keep Retry-After <= 30 s, the extension's maxRetryAfterMs, so a throttled client waits and
 *   retries instead of failing the drain.
 * - Control routes run a handful of times per recording/upload; 60 / 30 s per user + IP and 90 / 30 s per user.
 */
export const MEDIA_RATE_LIMITS: MediaRateLimits = {
  chunkPerSessionIp: { limit: 150, windowMs: 30_000 },
  chunkPerUserIp: { limit: 300, windowMs: 30_000 },
  chunkPerUser: { limit: 450, windowMs: 30_000 },
  controlPerUserIp: { limit: 60, windowMs: 30_000 },
  controlPerUser: { limit: 90, windowMs: 30_000 },
};

/** Retry-After sent when the limiter backend (Redis) is unreachable. */
export const RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_MS = 5_000;

/** The limiter could not be consulted: fail closed (503 + Retry-After), never let the request through unmetered. */
export class RateLimiterUnavailableError extends DomainError {
  constructor(public readonly retryAfterMs: number = RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_MS) {
    super('PROVIDER_UNAVAILABLE', 'Service temporarily unavailable, try again later', 503);
  }
}

export type MediaRateLimit = {
  /** Per-user buckets; charged before the ownership check (keys are the caller's own user, so only self-draining). */
  chunkUser(c: DirectoryCaller): Promise<void>;
  /** Per-session bucket; call only after the ownership check passed. */
  chunkSession(c: DirectoryCaller, sessionId: string): Promise<void>;
  control(c: DirectoryCaller): Promise<void>;
};

/** Checks run after auth, so keys are always an authenticated user (or its own session), with or without the IP. */
export function mediaRateLimit(
  rateLimiter: RateLimiter,
  limits: MediaRateLimits = MEDIA_RATE_LIMITS,
): MediaRateLimit {
  const consume = async (checks: (readonly [string, MediaLimit])[]) => {
    for (const [key, l] of checks) {
      let r;
      try {
        r = await rateLimiter.consume(key, l.limit, l.windowMs);
      } catch {
        throw new RateLimiterUnavailableError();
      }
      if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
    }
  };
  const ip = (c: DirectoryCaller) => c.meta.ip ?? 'unknown';
  const user = (c: DirectoryCaller) => `org:${c.ctx.organizationId}:user:${c.ctx.userId}`;
  return {
    chunkUser: (c) =>
      consume([
        [`media:chunk:user:${c.ctx.userId}`, limits.chunkPerUser],
        [`media:chunk:user:${c.ctx.userId}:ip:${ip(c)}`, limits.chunkPerUserIp],
      ]),
    chunkSession: (c, sessionId) =>
      consume([
        [`media:chunk:${user(c)}:session:${sessionId}:ip:${ip(c)}`, limits.chunkPerSessionIp],
      ]),
    control: (c) =>
      consume([
        [`media:ctl:user:${c.ctx.userId}`, limits.controlPerUser],
        [`media:ctl:user:${c.ctx.userId}:ip:${ip(c)}`, limits.controlPerUserIp],
      ]),
  };
}
