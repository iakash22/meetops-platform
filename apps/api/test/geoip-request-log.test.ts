import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { truncatingReqSerializer } from '../src/shared/geoip/index.js';
import { fakeHasher } from './helpers.js';

/** #290 M-1 / ADR-014: request logs never carry the full client IP. */
describe('request log IP truncation', () => {
  it('serializer truncates v4 to /24 and v6 to /48 and drops the port', () => {
    expect(truncatingReqSerializer({ method: 'GET', url: '/x', ip: '203.0.113.77' })).toEqual({
      method: 'GET',
      url: '/x',
      host: undefined,
      remoteAddress: '203.0.113.0/24',
    });
    expect(truncatingReqSerializer({ ip: '2001:db8:1:2::5' }).remoteAddress).toBe(
      '2001:db8:1::/48',
    );
    expect(truncatingReqSerializer({ ip: '::ffff:198.51.100.9' }).remoteAddress).toBe(
      '198.51.100.0/24',
    );
    expect(truncatingReqSerializer({ ip: 'garbage' }).remoteAddress).toBe('invalid');
  });

  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['2001:db8:1:2::5', '2001:db8:1::/48'],
  ])('real server request logs show %s only as %s', async (ip, truncated) => {
    const lines: string[] = [];
    const app = createServer({
      deps: { hasher: fakeHasher },
      logStream: { write: (l) => void lines.push(l) },
    });
    await app.ready();
    try {
      await app.inject({ method: 'GET', url: '/health', remoteAddress: ip });
    } finally {
      await app.close();
    }
    const out = lines.join('');
    expect(out).toContain('incoming request');
    expect(out).toContain(truncated);
    expect(out).not.toContain(ip);
    expect(out).not.toContain('remotePort');
  });
});
