import type { RetryPolicy } from './config.js';
import { AIError, toAIError } from './errors.js';

export type Sleeper = (ms: number) => Promise<void>;
export const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn with a hard timeout; the AbortSignal is passed through so SDK calls can cancel. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, provider?: string): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new AIError('TIMEOUT', `Timed out after ${timeoutMs}ms`, provider === undefined ? {} : { provider }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded retry with exponential backoff. Only retries errors flagged retryable. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: { provider?: string; sleep?: Sleeper; onAttemptError?: (err: AIError, attempt: number) => void } = {},
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const max = Math.min(Math.max(1, policy.maxAttempts), 5);
  let delay = policy.initialDelayMs;
  let last: AIError | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = toAIError(err, opts.provider);
      opts.onAttemptError?.(last, attempt);
      if (!last.retryable || attempt === max) throw last;
      await sleep(Math.min(delay, policy.maxDelayMs));
      delay = delay * policy.backoffMultiplier;
    }
  }
  throw last ?? new AIError('UNKNOWN', 'retry loop exited unexpectedly');
}
