import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * P9 R19: the same baseline as the API (R1) on every HTTP response the realtime process writes: Fastify routes,
 * 404s and Socket.IO / Engine.IO polling responses, including a rejected handshake (403). Set with `setHeader` from
 * a `request` listener that runs before Fastify and Engine.IO, so a later `writeHead` keeps them. A rejected raw
 * WebSocket upgrade is written straight to the socket by Engine.IO / ws (`HTTP/1.1 400 ...`), so an `upgrade`
 * listener splices the same headers into the first 4xx/5xx status block written to that socket.
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

const headerLines = (hsts: boolean) =>
  Object.entries(REALTIME_BASELINE_HEADERS)
    .concat(hsts ? [['strict-transport-security', REALTIME_HSTS]] : [])
    .map(([n, v]) => `${n}: ${v}\r\n`)
    .join('');

const REJECTION = /^HTTP\/1\.1 [45]\d\d [^\r\n]*\r\n/;

/** Insert the baseline after the status line of a raw 4xx/5xx upgrade rejection; anything else passes through. */
export function withRejectionHeaders(chunk: string, hsts: boolean): string {
  const m = REJECTION.exec(chunk);
  return m ? m[0] + headerLines(hsts) + chunk.slice(m[0].length) : chunk;
}

export function installSecurityHeaders(server: HttpServer, opts: { hsts: boolean }): void {
  server.prependListener('request', (_req, res) => {
    for (const [name, value] of Object.entries(REALTIME_BASELINE_HEADERS))
      res.setHeader(name, value);
    if (opts.hsts) res.setHeader('strict-transport-security', REALTIME_HSTS);
  });
  server.prependListener('upgrade', (_req, socket: Duplex) => {
    // #399 L3: the rejection can arrive through write() or end() (ws abortHandshake), as a string or a Buffer.
    // Only the first chunk written to the socket can be a status block; both hooks are removed after it.
    const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
    const end = socket.end.bind(socket) as (...args: unknown[]) => Duplex;
    let first = true;
    const splice = (chunk: unknown): unknown => {
      if (!first) return chunk;
      first = false;
      socket.write = write as Duplex['write'];
      socket.end = end as Duplex['end'];
      if (typeof chunk === 'string') return withRejectionHeaders(chunk, opts.hsts);
      if (Buffer.isBuffer(chunk)) {
        // HTTP status blocks are ASCII; latin1 round-trips any other bytes unchanged.
        const text = chunk.toString('latin1');
        const out = withRejectionHeaders(text, opts.hsts);
        return out === text ? chunk : Buffer.from(out, 'latin1');
      }
      return chunk;
    };
    socket.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(splice(chunk), ...rest)) as Duplex['write'];
    socket.end = ((chunk?: unknown, ...rest: unknown[]) =>
      typeof chunk === 'function' || chunk === undefined
        ? end(chunk, ...rest)
        : end(splice(chunk), ...rest)) as Duplex['end'];
  });
}
