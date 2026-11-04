import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import {
  API_CSP,
  DOCS_CSP,
  HSTS_VALUE,
  registerSecurityHeaders,
} from '../src/shared/security-headers.js';

const NO_INFRA = { databaseUrl: '', redisUrl: '' };

describe('P9: API baseline security headers', () => {
  it('sets the baseline on a plain response and on a 404, without caching rules or HSTS', async () => {
    const app = createServer({ nodeEnv: 'test', ...NO_INFRA });
    try {
      for (const url of ['/health', '/no-such-route']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBe(API_CSP);
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(res.headers['strict-transport-security']).toBeUndefined();
        // R3: non-2xx responses are never cached; a plain 2xx keeps no caching rule.
        expect(res.headers['cache-control']).toBe(url === '/health' ? undefined : 'no-store');
      }
    } finally {
      await app.close();
    }
  });

  it('never lets a credentialed or /auth response be cached', async () => {
    const app = createServer({ nodeEnv: 'test', ...NO_INFRA });
    try {
      const cookie = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { cookie: 'sid=placeholder' },
      });
      expect(cookie.headers['cache-control']).toBe('no-store');
      const bearer = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { authorization: 'Bearer placeholder' },
      });
      expect(bearer.headers['cache-control']).toBe('no-store');
      const auth = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(auth.headers['cache-control']).toBe('no-store');
      expect(auth.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app.close();
    }
  });

  it('keeps headers a route set itself, sends DOCS_CSP for Swagger UI, and sends HSTS when enabled', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { hsts: true, docs: true });
    app.get('/preview', async (_req, reply) =>
      reply
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .header('cache-control', 'private, max-age=60')
        .send('ok'),
    );
    app.get('/docs/static/index.html', async () => 'ui');
    try {
      const own = await app.inject({
        method: 'GET',
        url: '/preview',
        headers: { cookie: 'sid=placeholder' },
      });
      expect(own.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(own.headers['cache-control']).toBe('private, max-age=60');
      expect(own.headers['strict-transport-security']).toBe(HSTS_VALUE);
      const docs = await app.inject({ method: 'GET', url: '/docs/static/index.html' });
      expect(docs.headers['content-security-policy']).toBe(DOCS_CSP);
      expect(docs.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app.close();
    }
  });
});
