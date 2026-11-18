import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import type { RateLimiter } from '../src/modules/auth/domain/ports.js';
import {
  MEDIA_RATE_LIMITS,
  mediaRateLimit,
  RateLimiterUnavailableError,
} from '../src/modules/media/http/rate-limit.js';
import type { DirectoryCaller } from '../src/modules/directory/access.js';

function caller(ip: string | null | undefined): DirectoryCaller {
  return {
    ctx: { organizationId: 'org-1', userId: 'user-1' },
    meta: { ip },
  } as unknown as DirectoryCaller;
}

function spyLimiter(inner: RateLimiter = new InMemoryRateLimiter({ now: () => new Date() })) {
  const keys: string[] = [];
  const limiter: RateLimiter = {
    consume: async (key, limit, windowMs) => {
      keys.push(key);
      return inner.consume(key, limit, windowMs);
    },
  };
  return { limiter, keys };
}

/** clientIpKey throws synchronously; wrap so expect().rejects still works. */
const run = (p: () => Promise<void>) => Promise.resolve().then(p);

describe('media rate limit: clientIpKey (no shared unknown bucket)', () => {
  it('no client IP fails closed with 503 + Retry-After on every per-IP path (control, chunkUser, chunkSession)', async () => {
    for (const ip of [null, undefined, '', 'garbage'] as const) {
      const { limiter, keys } = spyLimiter();
      const rl = mediaRateLimit(limiter, MEDIA_RATE_LIMITS);
      const c = caller(ip);
      for (const call of [
        () => rl.control(c),
        () => rl.chunkUser(c),
        () => rl.chunkSession(c, 'sess-1'),
      ]) {
        const err = await run(call).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RateLimiterUnavailableError);
        expect((err as RateLimiterUnavailableError).statusCode).toBe(503);
        expect((err as RateLimiterUnavailableError).retryAfterMs).toBe(5_000);
      }
      // Nothing charged: the IP key is built before consume, so a missing IP never opens a shared bucket.
      expect(keys).toEqual([]);
    }
  });

  it('two different IPs get separate per-IP buckets; user-only keys stay shared', async () => {
    const { limiter, keys } = spyLimiter();
    const rl = mediaRateLimit(limiter, {
      ...MEDIA_RATE_LIMITS,
      controlPerUserIp: { limit: 1, windowMs: 30_000 },
      chunkPerUserIp: { limit: 1, windowMs: 30_000 },
      chunkPerSessionIp: { limit: 1, windowMs: 30_000 },
    });
    await rl.control(caller('203.0.113.10'));
    await rl.control(caller('203.0.113.11'));
    await rl.chunkUser(caller('198.51.100.1'));
    await rl.chunkUser(caller('198.51.100.2'));
    await rl.chunkSession(caller('192.0.2.1'), 'sess-a');
    await rl.chunkSession(caller('192.0.2.2'), 'sess-a');

    const ipKeys = keys.filter((k) => k.includes(':ip:'));
    expect(ipKeys).toEqual([
      'media:ctl:user:user-1:ip:203.0.113.10',
      'media:ctl:user:user-1:ip:203.0.113.11',
      'media:chunk:user:user-1:ip:198.51.100.1',
      'media:chunk:user:user-1:ip:198.51.100.2',
      'media:chunk:org:org-1:user:user-1:session:sess-a:ip:192.0.2.1',
      'media:chunk:org:org-1:user:user-1:session:sess-a:ip:192.0.2.2',
    ]);
    expect(keys.filter((k) => k === 'media:ctl:user:user-1')).toHaveLength(2);
    expect(keys.filter((k) => k === 'media:chunk:user:user-1')).toHaveLength(2);
    expect(keys.some((k) => k.includes('unknown'))).toBe(false);
  });

  it('an IPv4-mapped IPv6 address shares the bucket of its plain IPv4 form', async () => {
    const inner = new InMemoryRateLimiter({ now: () => new Date() });
    const { limiter, keys } = spyLimiter(inner);
    const rl = mediaRateLimit(limiter, {
      ...MEDIA_RATE_LIMITS,
      controlPerUserIp: { limit: 1, windowMs: 30_000 },
      chunkPerUserIp: { limit: 1, windowMs: 30_000 },
      chunkPerSessionIp: { limit: 1, windowMs: 30_000 },
    });
    await rl.control(caller('::ffff:203.0.113.50'));
    await expect(rl.control(caller('203.0.113.50'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
    await rl.chunkUser(caller('203.0.113.60'));
    await expect(rl.chunkUser(caller('::ffff:203.0.113.60'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
    await rl.chunkSession(caller('::ffff:198.51.100.7'), 'sess-b');
    await expect(rl.chunkSession(caller('198.51.100.7'), 'sess-b')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });

    expect(keys.filter((k) => k.includes(':ip:'))).toEqual([
      'media:ctl:user:user-1:ip:203.0.113.50',
      'media:ctl:user:user-1:ip:203.0.113.50',
      'media:chunk:user:user-1:ip:203.0.113.60',
      'media:chunk:user:user-1:ip:203.0.113.60',
      'media:chunk:org:org-1:user:user-1:session:sess-b:ip:198.51.100.7',
      'media:chunk:org:org-1:user:user-1:session:sess-b:ip:198.51.100.7',
    ]);
    expect(keys.some((k) => k.includes('unknown') || k.includes('::ffff:'))).toBe(false);
  });

  it("never puts the literal 'unknown' string into any media rate-limit key", async () => {
    const { limiter, keys } = spyLimiter();
    const rl = mediaRateLimit(limiter, MEDIA_RATE_LIMITS);
    await rl.control(caller('10.0.0.1'));
    await rl.chunkUser(caller('10.0.0.1'));
    await rl.chunkSession(caller('10.0.0.1'), 'sess-c');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => !k.includes('unknown'))).toBe(true);
  });
});
