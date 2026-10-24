import type { RetryPolicy } from './config.js';
import { AIError, toAIError } from './errors.js';

export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;
export const realSleep: Sleeper = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('TIMEOUT', 'aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new AIError('TIMEOUT', 'aborted'))), { once: true });
  });

/**
 * Run fn with a per-attempt timeout, chained to an optional parent (overall-deadline) signal.
 * The combined AbortSignal is passed to fn so HTTP calls / polling are cancelled.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  provider?: string,
  parent?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  const signal = parent ? AbortSignal.any([ac.signal, parent]) : ac.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = provider === undefined ? {} : { provider };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new AIError('TIMEOUT', `Timed out after ${timeoutMs}ms`, p));
    }, timeoutMs);
    signal.addEventListener('abort', () => reject(new AIError('TIMEOUT', 'Aborted (overall deadline)', p)), { once: true });
  });
  try {
    return await Promise.race([fn(signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded retry with exponential backoff. Only retries errors flagged retryable; stops when `signal` aborts. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: { provider?: string; sleep?: Sleeper; signal?: AbortSignal | undefined; onAttemptError?: (err: AIError, attempt: number) => void } = {},
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const max = Math.min(Math.max(1, policy.maxAttempts), 5);
  let delay = policy.initialDelayMs;
  let last: AIError | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (opts.signal?.aborted) throw new AIError('TIMEOUT', 'Overall deadline exceeded', opts.provider === undefined ? {} : { provider: opts.provider });
    try {
      return await fn(attempt);
    } catch (err) {
      last = toAIError(err, opts.provider);
      opts.onAttemptError?.(last, attempt);
      if (!last.retryable || attempt === max || opts.signal?.aborted) throw last;
      await sleep(Math.min(delay, policy.maxDelayMs), opts.signal);
      delay = delay * policy.backoffMultiplier;
    }
  }
  throw last ?? new AIError('UNKNOWN', 'retry loop exited unexpectedly');
}
