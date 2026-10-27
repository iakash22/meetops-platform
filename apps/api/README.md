# @meetops/api

Fastify 5 API (modular monolith: `src/modules/{auth,organizations,users}`).

- `node dist/index.js` starts the server (PORT, HOST).
- `import { createServer } from '@meetops/api'` builds the app without listening (tests/QA).

## Environment

| Variable        | Required              | Default (non-production)                      | Notes                                                                                                                                                                                                                          |
| --------------- | --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT` / `HOST` | no                    | `3000` / `0.0.0.0`                            |                                                                                                                                                                                                                                |
| `NODE_ENV`      | yes                   | –                                             | Only exactly `development` or `test` relax the checks; anything else (including unset and `staging`) is strict. `development` also drops `__Host-`/Secure on cookies.                                                          |
| `WEB_ORIGINS`   | **yes in production** | `http://localhost:5173,http://localhost:3000` | Comma-separated allowlist for browser CORS (`Access-Control-Allow-Origin` + credentials) and for the Origin/Referer check on every mutation. No default in production.                                                         |
| `CSRF_SECRET`   | **yes in production** | random per process                            | HMAC key for CSRF tokens, ≥ 32 bytes. Generate with `openssl rand -base64 48`.                                                                                                                                                 |
| `TRUST_PROXY`   | no                    | unset (`false`)                               | Comma list of proxy IPs/CIDRs (hop count `1` only in dev/test; it fails startup in production). `true` is rejected. Rate limits and lockout key on the resolved `request.ip`; X-Forwarded-For from untrusted peers is ignored. |

## Production startup checks

Unless `NODE_ENV` is `development` or `test`, `createServer` throws (refuses to start) unless these are injected via
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

## Generating CSRF_SECRET

```sh
openssl rand -base64 48
```

Use a different value per environment and keep it in the secret manager, not in `.env` files
that are committed. Rotating it invalidates outstanding CSRF tokens (clients re-fetch `GET /auth/csrf`).

## NODE_ENV and fail-closed startup

Only `NODE_ENV=development` or `NODE_ENV=test` (exact, lowercase) allow in-memory repositories,
limiter and lockout, a random per-process CSRF secret, and the localhost `WEB_ORIGINS` default.
Any other value, **including unset** and `staging`, runs the full production checks and refuses to
start unless everything is injected and `WEB_ORIGINS` and `CSRF_SECRET` are set. The test runner
sets `NODE_ENV=test` (`apps/api/vitest.config.ts`).

`TRUST_PROXY` list entries are validated as IPs or CIDRs; any invalid entry fails startup.
Logs redact `authorization`, `cookie`, `x-csrf-token` and `set-cookie` headers.

## Persistence adapters (P1-BE-2)

| Port                           | Production adapter                                                                                                                                                      | Status         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `UserRepository`               | `PrismaUserRepository` (users, global)                                                                                                                                  | ready          |
| `SessionRepository`            | `PrismaSessionRepository` (sessions, global; `expires_at` = sliding idle, `absolute_expires_at` = cap)                                                                  | ready          |
| `OrganizationRepository`       | `PrismaOrganizationRepository`                                                                                                                                          | ready          |
| `MembershipRepository`         | `PrismaMembershipRepository` — `withOrgContext`; `listByUser` uses `withUserContext`; last-owner check locks owner rows `FOR UPDATE`                                    | ready          |
| `InvitationRepository`         | `PrismaInvitationRepository` — token lookup/accept via SECURITY DEFINER `lookup_invitation_by_token_hash` / `accept_invitation`                                         | ready          |
| `AuditLog`                     | `PrismaAuditLog` — `createMany` for every row (org rows inside `withOrgContext`; null-org rows are insert-only for the app role)                                        | ready          |
| `OneTimeTokenRepository`       | `PrismaOneTimeTokenRepository` (`email_verifications` / `password_resets`, `UPDATE … WHERE used_at IS NULL RETURNING`); `RedisOneTimeTokenRepository` as an alternative | ready          |
| `RateLimiter` / `LoginLockout` | `RedisRateLimiter` / `RedisLoginLockout` (progressive: 5 failures → 1 min, doubling, cap 60 min)                                                                        | ready          |
| `AuthMailQueue`                | inline in dev/test; production must inject (`@meetops/notifications`, PR #11)                                                                                           | blocked on #11 |

Mail jobs carry ids only; `AuthMailJobHandler` (worker side) resolves recipients, mints tokens
(storing only the hash) and builds links from `WEB_BASE_URL`.

Live adapter tests: `TEST_DATABASE_URL=… TEST_REDIS_URL=… pnpm --filter @meetops/api exec vitest run test/prisma.integration.test.ts`
(skipped when unset).
