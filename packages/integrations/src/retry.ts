export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base for exponential backoff. Default 500ms. */
  baseDelayMs?: number;
  /** Cap for any single wait. If the server asks for longer, we stop retrying. Default 60s. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms clock. */
  now?: () => number;
  /** [0,1) RNG for jitter. */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void;
  /**
   * Whether repeating the operation is safe. Default true (reads, PUT/PATCH/DELETE).
   * Set false for non-idempotent writes (e.g. Jira `POST /issue`, GitHub `issues.create`): then only failures the
   * classifier marks `notProcessed` (429, 503 + Retry-After, rate-limit 403) are retried. Network errors, timeouts and
   * other 5xx are NOT retried because the request may already have been applied upstream (duplicate issue risk).
   * Pass true for a POST only when a real idempotency mechanism exists (e.g. an idempotency key honored by the API).
   */
  idempotent?: boolean;
}

export interface HttpErrorInfo {
  status?: number;
  /** Header lookup (case-insensitive). */
  header?: (name: string) => string | undefined;
}

/**
 * `notProcessed: true` means the server clearly rejected the request before acting on it (rate limit / overload with
 * Retry-After), so even a non-idempotent request can be safely resent.
 */
export type RetryDecision = { retry: false } | { retry: true; minDelayMs?: number; notProcessed?: boolean };

/** Parses Retry-After (delta seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * 429 -> retry (Retry-After honored); 403 with x-ratelimit-remaining: 0 -> wait until x-ratelimit-reset;
 * 403 with Retry-After (GitHub secondary limit) -> retry; 5xx -> retry; network error (no status) -> retry;
 * any other 4xx -> never retry.
 */
export function classifyHttpError(info: HttpErrorInfo, now: number): RetryDecision {
  const h = (n: string) => info.header?.(n);
  const status = info.status;
  if (status === undefined) return { retry: true };
  const retryAfter = parseRetryAfter(h('retry-after'), now);
  if (status === 429) return retryAfter !== undefined ? { retry: true, minDelayMs: retryAfter, notProcessed: true } : { retry: true, notProcessed: true };
  if (status === 403) {
    if (h('x-ratelimit-remaining') === '0') {
      const reset = Number(h('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : retryAfter;
      return wait !== undefined ? { retry: true, minDelayMs: wait, notProcessed: true } : { retry: true, notProcessed: true };
    }
    if (retryAfter !== undefined) return { retry: true, minDelayMs: retryAfter, notProcessed: true };
    return { retry: false };
  }
  if (status === 503 && retryAfter !== undefined) return { retry: true, minDelayMs: retryAfter, notProcessed: true };
  if (status >= 500 && status <= 599) return retryAfter !== undefined ? { retry: true, minDelayMs: retryAfter } : { retry: true };
  return { retry: false };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full-jitter backoff: random(0, min(maxDelay, base * 2^(attempt-1))). */
export function backoffDelay(attempt: number, base: number, max: number, random: () => number): number {
  return Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)));
}

/** RFC 9110 idempotent methods. POST (and Jira transition POSTs) are not. */
export function isIdempotentMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method.toUpperCase());
}

/**
 * Runs fn with retries. `classify` maps a thrown error to a decision (default: never retry).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown, now: number) => RetryDecision,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const d = classify(err, now());
      if (!d.retry) throw err;
      if (opts.idempotent === false && d.notProcessed !== true) throw err;
      if (d.minDelayMs !== undefined && d.minDelayMs > max) throw err;
      const delayMs = Math.min(max, Math.max(d.minDelayMs ?? 0, backoffDelay(attempt, base, max, random)));
      const info: { attempt: number; delayMs: number; status?: number } = { attempt, delayMs };
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number') info.status = status;
      opts.onRetry?.(info);
      await sleep(delayMs);
    }
  }
}

/** Classifier for Octokit RequestError-like errors ({ status, response: { headers } }). */
export function classifyOctokitError(err: unknown, now: number): RetryDecision {
  const e = err as { status?: unknown; response?: { headers?: Record<string, string | number | undefined> } };
  const headers = e.response?.headers ?? {};
  const info: HttpErrorInfo = {
    header: (n) => {
      const k = Object.keys(headers).find((x) => x.toLowerCase() === n);
      const v = k ? headers[k] : undefined;
      return v === undefined ? undefined : String(v);
    }
  };
  if (typeof e.status === 'number') info.status = e.status;
  return classifyHttpError(info, now);
}
