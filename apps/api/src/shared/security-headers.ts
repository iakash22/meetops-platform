import type { FastifyInstance } from 'fastify';

/**
 * Baseline response headers for every API response (P9 hardening, docs/p9/remaining-work.md #1). The API serves JSON
 * only, so the policy is maximally strict; routes that need something else (e.g. a notification preview) set their
 * own header first and it is kept.
 *
 * - `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: a
 *   JSON body can never be sniffed or rendered as a document, framed, or load anything.
 * - `X-Frame-Options: DENY` for old browsers, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`.
 * - `Cache-Control: no-store` on credentialed requests (cookie or Authorization) and every `/auth` response, so
 *   tokens, sessions and tenant data never land in shared or browser caches. An explicit route value is kept.
 * - `Strict-Transport-Security` only when enabled (production): plain-http dev and tests are unaffected.
 * - Swagger UI (`/docs`, dev/test only) needs scripts and styles, so it gets no CSP.
 */
export interface SecurityHeaderOptions {
  /** Send HSTS (production, behind TLS). */
  hsts: boolean;
}

export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

const setIfAbsent = (
  reply: { hasHeader(n: string): boolean; header(n: string, v: string): unknown },
  name: string,
  value: string,
) => {
  if (!reply.hasHeader(name)) reply.header(name, value);
};

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions,
): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? '';
    const isDocs = path === '/docs' || path.startsWith('/docs/');
    setIfAbsent(reply, 'x-content-type-options', 'nosniff');
    setIfAbsent(reply, 'referrer-policy', 'no-referrer');
    setIfAbsent(reply, 'x-frame-options', 'DENY');
    setIfAbsent(reply, 'cross-origin-opener-policy', 'same-origin');
    if (!isDocs) setIfAbsent(reply, 'content-security-policy', API_CSP);
    const credentialed =
      request.headers.authorization !== undefined || request.headers.cookie !== undefined;
    if (credentialed || path === '/auth' || path.startsWith('/auth/'))
      setIfAbsent(reply, 'cache-control', 'no-store');
    if (options.hsts) setIfAbsent(reply, 'strict-transport-security', HSTS_VALUE);
    return payload;
  });
}
