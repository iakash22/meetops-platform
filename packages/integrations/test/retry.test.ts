import { describe, it, expect, vi } from 'vitest';
import { isIdempotentMethod, withRetry, classifyHttpError, classifyOctokitError, parseRetryAfter, backoffDelay } from '../src';

const now = Date.parse('2026-10-21T00:00:00Z');
const hdr = (h: Record<string, string>) => (n: string) => h[n];

describe('parseRetryAfter', () => {
  it('handles seconds and HTTP-date', () => {
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});

describe('classifyHttpError', () => {
  it('retries 429 with Retry-After', () => {
    expect(classifyHttpError({ status: 429, header: hdr({ 'retry-after': '2' }) }, now)).toEqual({ retry: true, minDelayMs: 2000, notProcessed: true });
    expect(classifyHttpError({ status: 429 }, now)).toEqual({ retry: true, notProcessed: true });
  });
  it('waits until x-ratelimit-reset on exhausted 403', () => {
    const reset = String(Math.floor(now / 1000) + 10);
    expect(classifyHttpError({ status: 403, header: hdr({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }) }, now)).toEqual({ retry: true, minDelayMs: 10_000, notProcessed: true });
  });
  it('retries secondary-limit 403 with Retry-After, not plain 403', () => {
    expect(classifyHttpError({ status: 403, header: hdr({ 'retry-after': '60' }) }, now)).toEqual({ retry: true, minDelayMs: 60_000, notProcessed: true });
    expect(classifyHttpError({ status: 403, header: hdr({ 'x-ratelimit-remaining': '42' }) }, now)).toEqual({ retry: false });
  });
  it('retries 5xx and network errors, never other 4xx', () => {
    expect(classifyHttpError({ status: 502 }, now).retry).toBe(true);
    expect(classifyHttpError({}, now).retry).toBe(true);
    for (const s of [400, 401, 404, 409, 422]) expect(classifyHttpError({ status: s }, now).retry).toBe(false);
  });
  it('reads Octokit error headers', () => {
    expect(classifyOctokitError({ status: 429, response: { headers: { 'Retry-After': 1 } } }, now)).toEqual({ retry: true, minDelayMs: 1000, notProcessed: true });
  });
});

describe('withRetry', () => {
  it('uses full jitter capped by maxDelay', () => {
    expect(backoffDelay(1, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelay(10, 100, 1000, () => 0.5)).toBe(500);
  });
  it('retries until success with injected sleep', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 500 }).mockResolvedValue('ok');
    const res = await withRetry(fn, (e, n) => classifyHttpError(e as { status: number }, n), { sleep, random: () => 0.5, baseDelayMs: 100 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[50], [100]]);
  });
  it('honors server minimum delay over jitter', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValue(1);
    await withRetry(fn, () => ({ retry: true, minDelayMs: 7000 }), { sleep, random: () => 0 });
    expect(sleep).toHaveBeenCalledWith(7000);
  });
  it('gives up when server delay exceeds maxDelay, at maxAttempts, and on non-retryable', async () => {
    const sleep = vi.fn(async () => {});
    await expect(withRetry(vi.fn().mockRejectedValue({ status: 429 }), () => ({ retry: true, minDelayMs: 120_000 }), { sleep, maxDelayMs: 1000 })).rejects.toEqual({ status: 429 });
    const always = vi.fn().mockRejectedValue({ status: 500 });
    await expect(withRetry(always, () => ({ retry: true }), { sleep, maxAttempts: 3 })).rejects.toEqual({ status: 500 });
    expect(always).toHaveBeenCalledTimes(3);
    const once = vi.fn().mockRejectedValue({ status: 404 });
    await expect(withRetry(once, () => ({ retry: false }), { sleep })).rejects.toEqual({ status: 404 });
    expect(once).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency', () => {
  it('marks only clearly-unprocessed failures as notProcessed', () => {
    expect(classifyHttpError({ status: 503, header: hdr({ 'retry-after': '1' }) }, now)).toEqual({ retry: true, minDelayMs: 1000, notProcessed: true });
    expect(classifyHttpError({ status: 503 }, now)).toEqual({ retry: true });
    expect(classifyHttpError({ status: 500, header: hdr({ 'retry-after': '1' }) }, now)).toEqual({ retry: true, minDelayMs: 1000 });
    expect(classifyHttpError({}, now)).toEqual({ retry: true });
  });
  it('classifies HTTP methods', () => {
    for (const m of ['GET', 'get', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) expect(isIdempotentMethod(m)).toBe(true);
    for (const m of ['POST', 'PATCH']) expect(isIdempotentMethod(m)).toBe(false);
  });
  it('idempotent:false never retries network errors, timeouts or plain 5xx', async () => {
    const sleep = vi.fn(async () => {});
    for (const err of [{}, { status: 500 }, { status: 502 }, { status: 503 }]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, (e, n) => classifyHttpError(e as { status?: number }, n), { sleep, idempotent: false })).rejects.toEqual(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(sleep).not.toHaveBeenCalled();
  });
  it('idempotent:false still retries 429 and 503+Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    const e503 = { status: 503, h: { 'retry-after': '1' } };
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockRejectedValueOnce(e503).mockResolvedValue('ok');
    const classify = (e: unknown, n: number) => classifyHttpError({ status: (e as { status: number }).status, header: hdr((e as { h?: Record<string, string> }).h ?? {}) }, n);
    expect(await withRetry(fn, classify, { sleep, random: () => 0, idempotent: false })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('default (idempotent) keeps retrying network errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce({}).mockResolvedValue(1);
    expect(await withRetry(fn, (e, n) => classifyHttpError(e as { status?: number }, n), { sleep: async () => {} })).toBe(1);
  });
});
