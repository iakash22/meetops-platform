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
/** R2: two years; `preload` only once the owner registers the domain. */
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains';
/** R1: the JSON API never needs a powerful feature. */
export const API_PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()';

/**
 * R1 baseline, exact values. `apps/api/test/security-headers.matrix.test.ts` asserts these on every response class.
 * CORP is `same-site` (not `same-origin`) because the web app on a sibling subdomain reads the API with credentials.
 */
export const API_BASELINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': API_PERMISSIONS_POLICY,
  'x-permitted-cross-domain-policies': 'none',
});

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
    for (const [name, value] of Object.entries(API_BASELINE_HEADERS))
      setIfAbsent(reply, name, value);
    if (!isDocs) setIfAbsent(reply, 'content-security-policy', API_CSP);
    const credentialed =
      request.headers.authorization !== undefined || request.headers.cookie !== undefined;
    // R3: credentialed, every /auth path and every non-2xx response.
    const non2xx = reply.statusCode < 200 || reply.statusCode >= 300;
    if (credentialed || non2xx || path === '/auth' || path.startsWith('/auth/'))
      setIfAbsent(reply, 'cache-control', 'no-store');
    if (options.hsts) setIfAbsent(reply, 'strict-transport-security', HSTS_VALUE);
    return payload;
  });
}
