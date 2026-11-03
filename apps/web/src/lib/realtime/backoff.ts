export type BackoffOptions = { baseMs: number; maxMs: number; factor: number };

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 30_000, factor: 2 };

/** Full-jitter exponential backoff: random in [0.5, 1] x min(max, base * factor^attempt). */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * opts.factor ** Math.max(0, attempt));
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}
