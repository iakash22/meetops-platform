# @meetops/api

Fastify 5 API (modular monolith: `src/modules/{auth,organizations,users}`).

- `node dist/index.js` starts the server (PORT, HOST).
- `import { createServer } from '@meetops/api'` builds the app without listening (tests/QA).

## Environment

| Variable        | Required              | Default (non-production)                      | Notes                                                                                                                                                                            |
| --------------- | --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST` | no                    | `3000` / `0.0.0.0`                            |                                                                                                                                                                                  |
| `NODE_ENV`      | yes in prod           | –                                             | `production` enables strict checks below; `development` relaxes cookies.                                                                                                         |
| `WEB_ORIGINS`   | **yes in production** | `http://localhost:5173,http://localhost:3000` | Comma-separated allowlist for the Origin/Referer check on every mutation. No default in production.                                                                              |
| `CSRF_SECRET`   | **yes in production** | random per process                            | HMAC key for CSRF tokens, ≥ 32 bytes.                                                                                                                                            |
| `TRUST_PROXY`   | no                    | unset (`false`)                               | Hop count (`1`) or comma list of proxy IPs/CIDRs. `true` is rejected. Rate limits and lockout key on the resolved `request.ip`; X-Forwarded-For from untrusted peers is ignored. |

## Production startup checks

With `NODE_ENV=production`, `createServer` throws (refuses to start) unless these are injected via
`createServer({ deps })`: `users`, `sessions`, `passwordResets`, `organizations`, `memberships`,
`invitations`, `rateLimiter`, `lockout`, `mailer`. There are no in-memory defaults in production.
It also requires `WEB_ORIGINS` and `CSRF_SECRET`, and asserts the cookie policy below.

## Cookies

| Cookie            | Production                  | `NODE_ENV=development` | Flags                                                  |
| ----------------- | --------------------------- | ---------------------- | ------------------------------------------------------ |
| Session           | `__Host-meetops_sid`        | `meetops_sid`          | HttpOnly, SameSite=Lax, Path=/, Max-Age 12h, no Domain |
| CSRF              | `__Host-meetops_csrf`       | `meetops_csrf`         | readable by JS, SameSite=Lax, Path=/                   |
| Pre-session nonce | `__Host-meetops_presession` | `meetops_presession`   | HttpOnly, SameSite=Lax, Path=/                         |

Production (and any non-`development` env, including tests) always uses the `__Host-` prefix with
`Secure`. Development over plain http drops both, because browsers refuse `Secure`/`__Host-` cookies
on `http://localhost`. This is enforced at startup in production.

## CSRF

`GET /auth/csrf` returns `{ csrfToken }` and sets the CSRF cookie. Every POST/PUT/PATCH/DELETE must
send `X-CSRF-Token` equal to the cookie, plus an allowed `Origin` (or `Referer`).
The token is `nonce.HMAC(CSRF_SECRET, binding.nonce)`, where the binding is the session id, or, before
login, an HttpOnly pre-session nonce cookie. A token from another session, a stale pre-session
token after login, or a forged token is rejected with 403. Login returns a fresh `csrfToken`;
org create/switch rotate the session and refresh the CSRF cookie; re-fetch after logout.
