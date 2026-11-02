import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REALTIME_BASELINE_HEADERS,
  REALTIME_HSTS,
  withRejectionHeaders,
} from '../src/security-headers.js';
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

  it('splices the baseline into a raw WebSocket upgrade rejection', async () => {
    const { url } = await start();
    const { hostname, port } = new URL(url);
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(Number(port), hostname, () => {
        sock.write(
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n' +
            `Host: ${hostname}:${port}\r\n` +
            'Origin: https://evil.example\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 4\d\d /);
    const head = raw.split('\r\n\r\n')[0]!.toLowerCase();
    for (const [name, value] of Object.entries(REALTIME_BASELINE_HEADERS))
      expect(head, name).toContain(`${name}: ${value.toLowerCase()}`);
  });

  it('only rewrites 4xx/5xx status blocks', () => {
    const ok = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n';
    expect(withRejectionHeaders(ok, true)).toBe(ok);
    const bad = withRejectionHeaders(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nx',
      true,
    );
    expect(bad).toContain(`strict-transport-security: ${REALTIME_HSTS}\r\n`);
    expect(bad.endsWith('Connection: close\r\n\r\nx')).toBe(true);
  });
});
