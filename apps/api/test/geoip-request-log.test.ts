import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { requestSerializer } from '@meetops/logger';
import { truncateIp } from '../src/shared/geoip/index.js';
import { fakeHasher } from './helpers.js';

/** #290 M-1 / ADR-014: request logs never carry the full client IP. */
describe('request log IP truncation', () => {
  it('the single logger req serializer truncates v4 to /24 and v6 to /48 and drops the port', () => {
    const ser = requestSerializer(undefined, { mapIp: truncateIp });
    expect(ser({ method: 'GET', url: '/x', ip: '203.0.113.77', remotePort: 5 })).toEqual({
      method: 'GET',
      url: '/x',
      ip: '203.0.113.0/24',
    });
    expect(ser({ remoteAddress: '2001:db8:1:2::5' }).remoteAddress).toBe('2001:db8:1::/48');
    expect(ser({ ip: '::ffff:198.51.100.9' }).ip).toBe('198.51.100.0/24');
    expect(ser({ ip: 'garbage' }).ip).toBe('invalid');
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

  it('one request log line has the IP truncated AND OAuth code/state redacted', async () => {
    const lines: string[] = [];
    const app = createServer({
      deps: { hasher: fakeHasher },
      logStream: { write: (l) => void lines.push(l) },
    });
    await app.ready();
    try {
      await app.inject({
        method: 'GET',
        url: '/health?code=SECRETCODE123&state=SECRETSTATE456&keep=1',
        remoteAddress: '198.51.100.23',
      });
    } finally {
      await app.close();
    }
    const incoming = lines
      .map((l) => JSON.parse(l) as { msg?: string; req?: Record<string, unknown> })
      .find((l) => l.msg === 'incoming request');
    expect(incoming?.req).toMatchObject({
      url: '/health?code=***redacted***&state=***redacted***&keep=1',
      remoteAddress: '198.51.100.0/24',
    });
    const out = lines.join('');
    for (const leak of ['SECRETCODE123', 'SECRETSTATE456', '198.51.100.23', 'remotePort']) {
      expect(out).not.toContain(leak);
    }
  });
});
