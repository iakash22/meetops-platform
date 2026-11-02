import { afterEach, describe, expect, it } from 'vitest';
import { REALTIME_BASELINE_HEADERS, REALTIME_HSTS } from '../src/security-headers.js';
import { ORIGIN, runCleanups, start } from './fixtures.js';

afterEach(runCleanups);

const expectBaseline = (headers: Headers) => {
  for (const [name, value] of Object.entries(REALTIME_BASELINE_HEADERS))
    expect(headers.get(name), name).toBe(value);
};

describe('P9 R19: realtime HTTP security headers', () => {
  it('sends the baseline on /health and a 404, without HSTS outside production', async () => {
    const { url } = await start();
    for (const path of ['/health', '/nope']) {
      const res = await fetch(`${url}${path}`);
      expectBaseline(res.headers);
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
  });

  it('sends the baseline on an accepted and a rejected Engine.IO polling handshake', async () => {
    const { url } = await start();
    const ok = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: ORIGIN },
    });
    expect(ok.status).toBe(200);
    expectBaseline(ok.headers);
    const denied = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.status).toBe(403);
    expectBaseline(denied.headers);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds HSTS in production', async () => {
    const { url } = await start({}, { NODE_ENV: 'production' });
    const res = await fetch(`${url}/health`);
    expect(res.headers.get('strict-transport-security')).toBe(REALTIME_HSTS);
  });
});
