import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RateLimitedError as CoreRateLimited,
  RateLimiterUnavailableError as CoreUnavailable,
  clientIpKey,
} from '../src/shared/rate-limit-core.js';
import { RateLimitedError } from '../src/modules/auth/domain/errors.js';
import { RateLimiterUnavailableError } from '../src/modules/media/http/rate-limit.js';
import { routeLimiter } from '../src/shared/rate-limits.js';

/** #453 Architecture review follow-ups: no shared `unknown` IP bucket; shared code does not reach into modules. */
describe('shared rate-limit core', () => {
  it('refuses a request without a client IP instead of pooling it', () => {
    expect(clientIpKey('203.0.113.7')).toBe('203.0.113.7');
    for (const ip of [null, undefined, '', 'unknown', 'garbage'])
      expect(() => clientIpKey(ip)).toThrow(CoreUnavailable);
  });

  it('uses the shared @meetops/config normalisation (one bucket per address)', () => {
    expect(clientIpKey('::ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(clientIpKey(' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('public route buckets: no IP -> 503, and nothing is charged', async () => {
    const keys: string[] = [];
    const rl = routeLimiter({
      async consume(key) {
        keys.push(key);
        return { allowed: true, retryAfterMs: 0 };
      },
    });
    await expect(rl.charge('unsubscribe', { ip: null })).rejects.toBeInstanceOf(CoreUnavailable);
    await expect(rl.charge('oauthCallback', {})).rejects.toBeInstanceOf(CoreUnavailable);
    expect(keys).toEqual([]);
    await rl.charge('unsubscribe', { ip: '198.51.100.1' });
    expect(keys).toEqual(['rl:unsubscribe:ip:198.51.100.1']);
  });

  it('auth and media re-export the same classes (instanceof keeps working)', () => {
    expect(RateLimitedError).toBe(CoreRateLimited);
    expect(RateLimiterUnavailableError).toBe(CoreUnavailable);
  });

  it('ADR-001: shared rate-limit code imports nothing from inside a module', () => {
    for (const f of [
      'rate-limit-core.ts',
      'guarded-limit.ts',
      'rate-limits.ts',
      'http-errors.ts',
    ]) {
      const src = readFileSync(resolve(__dirname, '../src/shared', f), 'utf8');
      expect(src, f).not.toMatch(/from '\.\.\/modules\//);
    }
  });
});
