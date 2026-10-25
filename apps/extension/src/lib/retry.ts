/**
 * Retry with capped exponential backoff and jitter for the HTTP upload client. Pure and injectable (sleep, random,
 * now) so tests never wait on real timers.
 */
export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Delay before the first retry; doubles on every further retry. */
  baseDelayMs: number;
  /** Cap for a single backoff delay. */
  maxDelayMs: number;
  /** A server `Retry-After` longer than this is not waited out: the call fails and the next drain retries. */
  maxRetryAfterMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1). */
  random: () => number;
  now: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

export function retryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/** Transient HTTP statuses: request timeout, rate limiting and server/gateway errors. */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/** `Retry-After` as delta-seconds or an HTTP date, in ms from now. Undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Delay before retry number `retry` (1-based): equal jitter over min(maxDelay, base * 2^(retry-1)). */
export function backoffDelay(retry: number, p: RetryPolicy): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (retry - 1));
  return Math.round(ceiling / 2 + p.random() * (ceiling / 2));
}

/** What a failed attempt means for the retry loop. */
export interface RetryDecision {
  retry: boolean;
  /** Server-requested delay (Retry-After), which replaces the computed backoff when present. */
  retryAfterMs?: number | undefined;
}

/**
 * Run `fn` until it succeeds, `classify` says the error is final, or attempts run out. The last error is rethrown
 * unchanged so callers keep its type.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => RetryDecision,
  p: RetryPolicy,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const d = classify(err);
      if (!d.retry || attempt >= p.maxAttempts) throw err;
      if (d.retryAfterMs !== undefined && d.retryAfterMs > p.maxRetryAfterMs) throw err;
      await p.sleep(d.retryAfterMs ?? backoffDelay(attempt, p));
    }
  }
}

/** fetch() rejects with a TypeError when the network fails (offline, DNS, connection reset, CORS). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}
