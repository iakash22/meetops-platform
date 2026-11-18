# P9 security headers, CORS, cookies and CSRF: requirements

For Techy on `fix/api-security-headers`. Audited 3 Nov 2026 (IST) on `integration/phase-1` @ `78d8968b` by reading code
(`apps/api/src/shared/security-headers.ts`, `shared/http-errors.ts`, `modules/index.ts` CORS, `modules/auth/http/security.ts`,
`apps/realtime/src`, `apps/web/index.html`, `apps/web/vite.config.ts`, `infra/docker/nginx/web.conf.template`).
The API was **not** started locally (box is short on inodes and other gates were running); every requirement below has an
`app.inject()` / nginx test so the behaviour is proven in CI instead.

## Current state (what is already right)

- API `onSend` hook sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  `Cache-Control: no-store` on credentialed and `/auth*` responses, HSTS `max-age=31536000; includeSubDomains` when `NODE_ENV=production`.
- CORS: `@fastify/cors` delegator, exact-match allowlist from `WEB_ORIGINS` (required when strict), `credentials: true`, no reflection,
  `strictPreflight`, `maxAge 600`, allowed headers `content-type, x-csrf-token`; desktop/extension token routes excluded; extension
  bearer routes get separate credential-less CORS.
- Cookies: `__Host-meetops_sid` (HttpOnly), `__Host-meetops_csrf` (readable), `__Host-meetops_presession` (HttpOnly), all `Secure; Path=/; SameSite=Lax`
  outside `NODE_ENV=development`; `assertProductionCookies` throws otherwise.
- CSRF: HMAC token bound to session id (or pre-session nonce), `X-CSRF-Token` on unsafe methods, plus Origin/Referer allowlist check (missing both → reject).
- Errors: generic 4xx/500 envelopes, validation details reduced to `{path, message:'invalid'}`, no stack or body echo.
- Swagger UI only when `NODE_ENV` is exactly `development|test`.
- Web (nginx): CSP without `unsafe-inline`/`unsafe-eval`, `frame-ancestors 'none'`, `object-src 'none'`, nosniff, Referrer-Policy, Permissions-Policy, XFO, COOP.

## Gaps (ranked)

| Gap                                                                                                                                                                              | Where      | Risk                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| G1 `apps/realtime` (Fastify + WS) sets **no** security headers at all                                                                                                            | realtime   | medium                                                                 |
| G2 No `Cross-Origin-Resource-Policy` on API or web                                                                                                                               | api, nginx | medium (cross-origin reads of JSON via `<script>`/Spectre-class leaks) |
| G3 Web nginx sends **no HSTS** and no `upgrade-insecure-requests` (depends on unknown TLS terminator)                                                                            | nginx      | medium                                                                 |
| G4 API lacks `Permissions-Policy`; `X-Permitted-Cross-Domain-Policies` and `Origin-Agent-Cluster` absent                                                                         | api        | low                                                                    |
| G5 Web CSP has no reporting (`report-to`) and no `require-trusted-types-for 'script'`; `connect-src` includes env origins without validation (empty/`*` env would weaken it)     | nginx      | low/medium                                                             |
| G6 `/assets/` responses have no `immutable` and HTML has `expires -1` but no explicit `Cache-Control: no-store` for `index.html`                                                 | nginx      | low                                                                    |
| G7 Vite dev/preview server sets no headers, so CSP breakage is only found after deploy                                                                                           | web dev    | low (process)                                                          |
| G8 CORS responses: no test that `Vary: Origin` is present on allowed **and** disallowed origins; `exposedHeaders` not declared (`Retry-After`, `X-Request-Id` unreadable by web) | api        | low                                                                    |
| G9 Session cookie `SameSite=Lax`; acceptable with CSRF token, but no `Max-Age` cap test on CSRF/pre-session cookies (pre-session has no expiry)                                  | api        | low                                                                    |
| G10 `trustProxy` parse and `X-Forwarded-Proto` drive `Secure`/HSTS decisions; no test that a spoofed header from a non-trusted hop is ignored                                    | api        | medium                                                                 |
| G11 Unknown-content-type / 413 / 415 / malformed-JSON paths: generic, but not covered by a "no stack, no framework message" test matrix                                          | api        | low                                                                    |

## Requirements

Each requirement is numbered for the PR checklist; **Test** is the minimum test that must exist.

### API (`apps/api`)

- **R1 Baseline headers on every response** (2xx, 3xx, 4xx, 5xx, 404, CORS preflight, rate-limited 429):
  `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`;
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  `Cross-Origin-Opener-Policy: same-origin`; **new** `Cross-Origin-Resource-Policy: same-site`;
  **new** `Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()`;
  **new** `X-Permitted-Cross-Domain-Policies: none`.
  _Test:_ table-driven `app.inject` over `GET /health`, `GET /nope` (404), a forced 500 route, `OPTIONS` preflight from an allowed origin, a 429; assert every header exactly.
- **R2 HSTS** `Strict-Transport-Security: max-age=63072000; includeSubDomains` (add `; preload` only after the owner registers the domain) when `NODE_ENV=production`; never in dev/test.
  _Test:_ production build of the app sends it; development does not.
- **R3 Cache-Control** `no-store` on any credentialed request, every `/auth*` path and every non-2xx; public static JSON may set its own. Also `Pragma: no-cache` not required.
  _Test:_ cookie request, bearer request, `/auth/csrf`, a 401: all `no-store`.
- **R4 Route overrides are explicit:** a route may override CSP/CORP only via a named helper (`reply.securityOverride({...})`) that is grep-able; `/docs` is the only CSP-less path and only in `development|test`.
  _Test:_ production app returns 404 for `/docs` and `/docs/json`.
- **R5 Error responses** never contain `stack`, `err.message` from non-Domain errors, Fastify/ajv internals, SQL/Prisma text, file paths or the request body.
  _Test:_ matrix: malformed JSON, wrong content-type (415), oversize body (413), schema violation, thrown `Error('secret /etc/x')`, Prisma `P2002`; assert body is the contracts envelope and does not match `/stack|at \w+ \(|prisma|\/src\//i`.
- **R6 Server header**: no `X-Powered-By`; no version in `Server`.
  _Test:_ header absent.

### CORS

- **R7 Allowlist from env:** `WEB_ORIGINS` = comma-separated exact origins (`scheme://host[:port]`), parsed once at boot; reject at boot `*`, `null`, paths, queries, trailing junk, `http://` in production (except none). Mirror the realtime validator (`REALTIME_CORS_ORIGINS`).
  _Test:_ config unit tests for each invalid form; boot fails in production with `WEB_ORIGINS` unset.
- **R8 Credentials rules:** `Access-Control-Allow-Credentials: true` **only** together with an exact echoed allowed origin; never with `*`; unknown origins get **no** `Access-Control-Allow-*` headers (request still processed for same-origin/no-Origin GET, but unsafe methods are rejected by the Origin check).
  _Test:_ allowed origin → echo + credentials; `https://evil.example` → no ACAO/ACAC; `null` origin → none.
- **R9 Preflight:** `OPTIONS` from an allowed origin returns 204 with `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE`, `Access-Control-Allow-Headers: content-type, x-csrf-token`, `Access-Control-Max-Age: 600`; disallowed origin or disallowed requested header returns 4xx without ACAO.
  _Test:_ both cases.
- **R10 `Vary: Origin`** on every response to a request carrying `Origin` (allowed or not), so caches never serve one origin's CORS headers to another.
  _Test:_ assert on allowed and denied origins.
- **R11 Exposed headers:** `Access-Control-Expose-Headers: retry-after, x-request-id` only.
  _Test:_ present on an allowed-origin 429.
- **R12 Non-browser routes stay CORS-free:** desktop token/refresh/revoke/switch-org and extension lifecycle paths never return web CORS headers; extension bearer routes return credential-less CORS (`ACAC` absent) for allowlisted `chrome-extension://<id>` only.
  _Test:_ existing ADR-005/012 tests extended with `Vary` and ACAC-absent assertions.

### Cookies

- **R13** Production cookie set: `__Host-meetops_sid` (`HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=<absolute timeout>`), `__Host-meetops_csrf` (`Secure; Path=/; SameSite=Strict`; not HttpOnly; `Max-Age` = session absolute timeout), `__Host-meetops_presession` (`HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=3600`). No `Domain` attribute on any.
  _Test:_ parse `Set-Cookie` from login and `/auth/csrf` in production mode; assert each attribute and absence of `Domain`.
- **R14** Logout clears all three with matching attributes (`Max-Age=0`, same name/path/prefix).
  _Test:_ logout response `Set-Cookie` lines.
- **R15** Boot guard stays: `NODE_ENV` other than exactly `development` ⇒ `__Host-` + `Secure`; `CSRF_SECRET` ≥32 bytes.
  _Test:_ existing `assertProductionCookies` tests plus `NODE_ENV=staging`.

### CSRF

- **R16** Keep the double-submit HMAC token (session-bound or pre-session-bound) + Origin/Referer allowlist on POST/PUT/PATCH/DELETE. Token compare is `timingSafeEqual`. JSON-only bodies: reject unsafe requests whose `Content-Type` is not `application/json` (or the multipart upload route) with 415, so form-posts can't hit JSON routes.
  _Test:_ missing token 403 `CSRF_INVALID`; token from another session 403; valid token + evil Origin 403; no Origin and no Referer 403; `text/plain` POST 415.
- **R17** Token rotates on login, org switch and logout.
  _Test:_ old token rejected after each.

### Proxy trust

- **R18** `TRUST_PROXY` is an explicit hop list/CIDR; `X-Forwarded-For`/`-Proto` from untrusted peers is ignored for client IP, rate limiting and `Secure` decisions.
  _Test:_ inject with spoofed `X-Forwarded-For` from an untrusted remote address; `request.clientIp` is the socket address.

### Realtime (`apps/realtime`)

- **R19** Same baseline headers as R1 on all HTTP responses (incl. failed WS upgrade 4xx); handshake rejects origins outside `REALTIME_CORS_ORIGINS`/extension ids (already enforced; add the header test).
  _Test:_ inject `GET /health` and a rejected upgrade; assert headers.

### Web (`apps/web`, `infra/docker/nginx/web.conf.template`)

- **R20 CSP** (server header, not meta):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${CSP_API_ORIGIN} ${CSP_REALTIME_ORIGIN} ${CSP_STORAGE_ORIGIN}; media-src 'self' blob: ${CSP_STORAGE_ORIGIN}; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests; report-to csp`
  plus `Reporting-Endpoints: csp="${CSP_REPORT_URL}"` when set. No `unsafe-inline`/`unsafe-eval`. If an inline script is ever needed, use a **sha256 hash** generated at build (Vite plugin writes the hash into the template); nonces are not needed because nginx serves a static `index.html`.
  Container entrypoint must refuse to start if any `CSP_*_ORIGIN` is empty-but-required, `*`, or not `https://` in production.
  _Test:_ `scripts/check-csp.mjs` greps built `dist/index.html` for inline `<script>` without a matching hash and for `style=` attributes; nginx container smoke test (`curl -sI`) asserts the exact header; entrypoint unit test for bad env values.
- **R21** `Strict-Transport-Security: max-age=63072000; includeSubDomains` at nginx (or documented as set by the TLS terminator, with a deploy smoke test either way).
  _Test:_ `curl -sI https://<staging>` in the release checklist.
- **R22** Add `Cross-Origin-Resource-Policy: same-origin`, keep `Cross-Origin-Opener-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()`.
  _Test:_ nginx smoke test on `/`, `/assets/<file>`, a 404 and `/healthz` (all via `always`).
- **R23** Caching: `index.html` and SPA fallback `Cache-Control: no-store`; `/assets/*` `Cache-Control: public, max-age=31536000, immutable`. Must not use `add_header` inside `location` (drops server headers): use `expires` + a `map` on `$uri`.
  _Test:_ smoke test asserts both cache headers and that security headers are still present on `/assets/*`.
- **R24** Vite dev and preview servers send the same CSP (with `connect-src` adding `ws://localhost:*` for HMR only in dev) so violations show up locally.
  _Test:_ Playwright (or vitest + `preview`) loads `/` with zero `securitypolicyviolation` events.
- **R25** No security-relevant `<meta http-equiv>` in `index.html` (headers are the source of truth; meta CSP can't set `frame-ancestors`).
  _Test:_ lint check on `index.html`.

## Done criteria

All R1–R25 tests green in the gate; a single fixture table (`apps/api/test/security-headers.matrix.test.ts`) is the source for API header values; ADR or `docs/12-security` updated with the final header table.
