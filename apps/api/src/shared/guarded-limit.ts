import type { RateLimiter } from '../modules/auth/domain/ports.js';
import { RateLimitedError } from '../modules/auth/domain/errors.js';
import {
  RATE_LIMITER_TIMEOUT_MS,
  RateLimiterUnavailableError,
} from '../modules/media/http/rate-limit.js';

export { RATE_LIMITER_TIMEOUT_MS, RateLimiterUnavailableError };

export type LimitWindow = { readonly limit: number; readonly windowMs: number };

/**
 * One fail-closed rate-limit check, modelled on modules/media/http/rate-limit.ts:
 * - limiter rejects, or does not settle within `timeoutMs` (default 1.5 s) -> RateLimiterUnavailableError
 *   (503 + Retry-After), never an unmetered pass;
 * - over the limit -> RateLimitedError (429 + Retry-After).
 * Kept byte-identical in every branch that carries it, so parallel PRs merge cleanly.
 */
export async function consumeGuarded(
  rateLimiter: RateLimiter,
  key: string,
  l: LimitWindow,
  timeoutMs: number = RATE_LIMITER_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('rate limiter timeout')), timeoutMs);
  });
  let r: Awaited<ReturnType<RateLimiter['consume']>>;
  try {
    r = await Promise.race([rateLimiter.consume(key, l.limit, l.windowMs), timeout]);
  } catch {
    throw new RateLimiterUnavailableError();
  } finally {
    clearTimeout(timer);
  }
  if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
}
