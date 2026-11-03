import type { FastifyInstance, FastifyReply } from 'fastify';

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
 * - Swagger UI (`/docs`; dev/test, or production only with API_DOCS_ENABLED=true) gets DOCS_CSP: same-origin scripts,
 *   styles, images and fetches only. No inline script, no eval, no framing, no third-party origin.
 */
export interface SecurityHeaderOptions {
  /** Send HSTS (production, behind TLS). */
  hsts: boolean;
  /** R4: Swagger UI is mounted (see docsEnabledFromEnv); only then does `/docs` get DOCS_CSP instead of API_CSP. */
  docs?: boolean;
}

/** R4: the only sanctioned way for a route to replace the baseline CSP/CORP (grep for `securityOverride(`). */
export interface SecurityOverride {
  csp?: string;
  corp?: 'same-origin' | 'same-site' | 'cross-origin';
}

declare module 'fastify' {
  interface FastifyReply {
    securityOverride(override: SecurityOverride): FastifyReply;
  }
}

export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/**
 * Strict CSP for the Swagger UI pages. @fastify/swagger-ui 6 serves only external same-origin scripts and styles
 * (no inline <script>), so 'self' is enough. `data:` images are its inline SVG icons; `connect-src 'self'` is
 * "Try it out" plus the /docs/json spec.
 */
export const DOCS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

/**
 * Whether Swagger UI (/docs, /docs/json) is mounted. On by default only for NODE_ENV exactly development|test.
 * Any other NODE_ENV (production, staging, unset) needs an explicit API_DOCS_ENABLED=true; any other value is off
 * (fails closed).
 */
export function docsEnabledFromEnv(nodeEnv: string | undefined, raw: string | undefined): boolean {
  if (nodeEnv === 'development' || nodeEnv === 'test') return true;
  return raw?.trim().toLowerCase() === 'true';
}

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
  app.decorateReply('securityOverride', function (this: FastifyReply, o: SecurityOverride) {
    if (o.csp !== undefined) this.header('content-security-policy', o.csp);
    if (o.corp !== undefined) this.header('cross-origin-resource-policy', o.corp);
    return this;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? '';
    const isDocs = options.docs === true && (path === '/docs' || path.startsWith('/docs/'));
    for (const [name, value] of Object.entries(API_BASELINE_HEADERS))
      setIfAbsent(reply, name, value);
    setIfAbsent(reply, 'content-security-policy', isDocs ? DOCS_CSP : API_CSP);
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
