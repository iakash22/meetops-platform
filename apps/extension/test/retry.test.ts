import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  retryPolicy,
  withRetry,
} from '../src/lib/retry.js';

const NOW = Date.parse('2026-10-25T08:00:00.000Z');

describe('retry helpers', () => {
  it('classifies transient statuses', () => {
    expect([408, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 409, 413, 501].some(isRetryableStatus)).toBe(false);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3000);
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
    expect(parseRetryAfter(new Date(NOW - 5000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });

  it('backs off exponentially with equal jitter, capped', () => {
    const p = retryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 });
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, p))).toEqual([
      50, 100, 200, 400, 500, 500,
    ]);
    expect(backoffDelay(1, { ...p, random: () => 0.999 })).toBe(100);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const sleeps: number[] = [];
    const p = retryPolicy({
      maxAttempts: 3,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 1,
    });
    let n = 0;
    const errs: Error[] = [new Error('a'), new Error('b'), new Error('c')];
    await expect(
      withRetry(
        async () => {
          throw errs[n++] ?? new Error('unexpected');
        },
        () => ({ retry: true }),
        p,
      ),
    ).rejects.toBe(errs[2]);
    expect(n).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('stops immediately on a final error', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('x');
        },
        () => ({ retry: false }),
        retryPolicy(),
      ),
    ).rejects.toThrow('x');
    expect(n).toBe(1);
  });
});
