import type { Server as HttpServer } from 'node:http';

/**
 * P9 R19: the same baseline as the API (R1) on every HTTP response the realtime process writes: Fastify routes,
 * 404s and Socket.IO / Engine.IO polling responses, including a rejected handshake (403). Set with `setHeader` from
 * a `request` listener that runs before Fastify and Engine.IO, so a later `writeHead` keeps them. A raw WebSocket
 * upgrade rejection is written to the socket by Engine.IO and is not covered (deferred, see PR).
 */
export const REALTIME_BASELINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'x-permitted-cross-domain-policies': 'none',
});
export const REALTIME_HSTS = 'max-age=63072000; includeSubDomains';

export function installSecurityHeaders(server: HttpServer, opts: { hsts: boolean }): void {
  server.prependListener('request', (_req, res) => {
    for (const [name, value] of Object.entries(REALTIME_BASELINE_HEADERS))
      res.setHeader(name, value);
    if (opts.hsts) res.setHeader('strict-transport-security', REALTIME_HSTS);
  });
}
