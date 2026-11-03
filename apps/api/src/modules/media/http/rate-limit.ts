import type { RateLimiter } from '../../auth/domain/ports.js';
import { RateLimitedError } from '../../auth/domain/errors.js';
import type { DirectoryCaller } from '../../directory/access.js';

export type MediaLimit = { limit: number; windowMs: number };

export type MediaRateLimits = {
  /** Chunk upload-URL presigns, per authenticated user + client IP (all of that user's sessions). */
  chunkPerUserIp: MediaLimit;
  /** Chunk upload-URL presigns, per recording session + client IP. */
  chunkPerSessionIp: MediaLimit;
  /**
   * Upload init/complete and recording-session init/complete/abort, per user + IP. Shared by cookie (web) and
   * ADR-005 bearer (extension, desktop) callers, which reach the same routes.
   */
  controlPerUserIp: MediaLimit;
};

/**
 * Sizing (full reasoning in docs/p9/media-rate-limits.md):
 * - Live cadence: the extension records 5 s timeslices (TIMESLICE_MS), splitting a slice into <= 8 MiB seqs only when
 *   it is oversized; desktop records 10 s timeslices. So one session presigns ~6 chunks per 30 s, ~12 in the worst
 *   split case. 150 / 30 s per session is >= 12x that, and leaves room to drain an offline backlog at 5 presigns/s.
 * - Per user: 300 / 30 s (10/s) covers several concurrent sessions (extension + desktop, re-tries) at full backlog
 *   drain speed.
 * - 30 s windows keep Retry-After <= 30 s, the extension's maxRetryAfterMs, so a throttled client waits and
 *   retries instead of failing the drain.
 * - Control routes run a handful of times per recording/upload; 60 / 30 s per user is far above any real use.
 */
export const MEDIA_RATE_LIMITS: MediaRateLimits = {
  chunkPerUserIp: { limit: 300, windowMs: 30_000 },
  chunkPerSessionIp: { limit: 150, windowMs: 30_000 },
  controlPerUserIp: { limit: 60, windowMs: 30_000 },
};

export type MediaRateLimit = {
  chunk(c: DirectoryCaller, sessionId: string): Promise<void>;
  control(c: DirectoryCaller): Promise<void>;
};

/** Checks run after auth, so keys are always an authenticated user (or its session) plus the client IP. */
export function mediaRateLimit(
  rateLimiter: RateLimiter,
  limits: MediaRateLimits = MEDIA_RATE_LIMITS,
): MediaRateLimit {
  const consume = async (checks: (readonly [string, MediaLimit])[]) => {
    for (const [key, l] of checks) {
      const r = await rateLimiter.consume(key, l.limit, l.windowMs);
      if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
    }
  };
  const ip = (c: DirectoryCaller) => c.meta.ip ?? 'unknown';
  return {
    chunk: (c, sessionId) =>
      consume([
        [`media:chunk:session:${sessionId}:ip:${ip(c)}`, limits.chunkPerSessionIp],
        [`media:chunk:user:${c.ctx.userId}:ip:${ip(c)}`, limits.chunkPerUserIp],
      ]),
    control: (c) =>
      consume([[`media:ctl:user:${c.ctx.userId}:ip:${ip(c)}`, limits.controlPerUserIp]]),
  };
}
