# Auth, organizations and users API (P1-BE)

Source: `apps/api` on `integration/phase-1`, as merged by PR #27 (head `ec3cdfa`, merged 2026-10-22 00:07 IST). Contracts come from `@meetops/contracts` (0.3.2 on `integration/phase-1`). It reaches `main` with the integration PR (#30). See also `apps/api/README.md`.

> Repositories, the rate limiter, the lockout and the mailer are **in-memory or no-op only in `NODE_ENV=development` or `test`**. In any other environment (including unset), `createServer` refuses to start unless real implementations are injected and `WEB_ORIGINS` and `CSRF_SECRET` are set. Prisma persistence is Backend PR #53 (open).

## Endpoints

"Session" means a valid session cookie. Every POST also passes the Origin and CSRF guard (below).

| Method | Path                                         | Auth           | Request                                      | Response                                                                                         |
| ------ | -------------------------------------------- | -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/health`                                    | Public         | None                                         | 200 `{ status: 'ok' }`                                                                           |
| GET    | `/ready`                                     | Public         | None                                         | 200 `{ status: 'ready' }`                                                                        |
| GET    | `/auth/csrf`                                 | Public         | None                                         | 200 `{ csrfToken }`; sets the CSRF cookie (and a pre-session cookie if there's no session)       |
| POST   | `/auth/signup`                               | Public         | `{ name, email, password }` (12–128)         | 202 `{ message }`, same body whether or not the email exists; no session                         |
| POST   | `/auth/login`                                | Public         | `{ email, password }`                        | 200 session response plus `csrfToken`; sets the session and CSRF cookies; 401 `AUTH_FAILED`; 429 |
| POST   | `/auth/forgot-password`                      | Public         | `{ email }`                                  | 202 `{ message }` (enumeration-safe)                                                             |
| POST   | `/auth/reset-password`                       | Public         | `{ token, password }`                        | 204; single-use token, 30-minute TTL; revokes all of the user's sessions                         |
| POST   | `/auth/logout`                               | Session        | None                                         | 204; revokes the session and clears the cookie                                                   |
| GET    | `/auth/session`                              | Session        | None                                         | 200 session response; slides the idle timeout; 401                                               |
| GET    | `/orgs`                                      | Session        | None                                         | 200 `Paginated<{ organization, role }>`                                                          |
| POST   | `/orgs`                                      | Session        | `{ name }`                                   | 201 `{ organization, role }`; creator becomes owner; session rotates                             |
| GET    | `/orgs/:id`                                  | Session        | None                                         | 200 `{ organization, role }`; 404 for non-members                                                |
| POST   | `/orgs/switch`                               | Session        | `{ organizationId }`                         | 200 `{ organization, role }`; session rotates                                                    |
| POST   | `/orgs/:id/invitations`                      | Session + CASL | `{ email, role: admin \| member \| viewer }` | 201 `Invitation` (same response for any address)                                                 |
| POST   | `/orgs/:id/invitations/:invitationId/revoke` | Session + CASL | None                                         | 200 `Invitation`; cross-org 404                                                                  |
| POST   | `/invitations/accept`                        | Session        | `{ token }`                                  | 200 `{ organization, role }`; every failure is the same 404                                      |

The session response (`GetAuthSessionResponse`) is `{ user, organizations, memberships, activeOrganizationId | null, role | null, expiresAt }`. DTOs never include hashes or tokens. Request schemas reject unknown properties. Swagger UI is served at `/docs`.

## Cookies

| Cookie            | Production                  | `NODE_ENV=development` | Flags                                                   |
| ----------------- | --------------------------- | ---------------------- | ------------------------------------------------------- |
| Session           | `__Host-meetops_sid`        | `meetops_sid`          | HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h, no Domain |
| CSRF              | `__Host-meetops_csrf`       | `meetops_csrf`         | Readable by JS, SameSite=Lax, Path=/                    |
| Pre-session nonce | `__Host-meetops_presession` | `meetops_presession`   | HttpOnly, SameSite=Lax, Path=/                          |

- Every environment except `development` uses the `__Host-` prefix plus `Secure`, and that's asserted at startup. Development over plain http drops both, because browsers refuse them on `http://localhost`.
- Session tokens are opaque 256-bit values stored as SHA-256 hashes.
- Sessions have a 30-minute sliding idle timeout and a 12-hour absolute timeout, and they rotate on login, org create and org switch.

## CSRF flow

1. `GET /auth/csrf` returns `{ csrfToken }` and sets the CSRF cookie. The token is `nonce.HMAC-SHA256(CSRF_SECRET, "<binding>.<nonce>")`. The binding is `s:<sessionId>` when there's a session; otherwise it's `p:<nonce>`, taken from a new HttpOnly pre-session cookie.
2. Every POST, PUT, PATCH or DELETE must send `X-CSRF-Token` equal to the CSRF cookie, and the HMAC must verify against the request's current binding. A token from another session, a stale pre-session token after login, or a forged token is rejected.
3. Login returns a fresh `csrfToken`. Org create and switch refresh the cookie. Clients re-fetch after logout.
4. `Origin` (or `Referer` as a fallback) must be in `WEB_ORIGINS`. Requests with neither are rejected.

## Configuration

| Variable        | Notes                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`      | Only exactly `development` or `test` relax the checks                                                        |
| `WEB_ORIGINS`   | Comma-separated allowlist; required in production; dev default `http://localhost:5173,http://localhost:3000` |
| `CSRF_SECRET`   | HMAC key, at least 32 bytes; required in production; random per process in dev and test                      |
| `TRUST_PROXY`   | Hop count or comma list of proxy IPs/CIDRs; `true` and `/0` are rejected; default off                        |
| `PORT` / `HOST` | Default `3000` / `0.0.0.0`                                                                                   |

## Rate limits and lockout

| Action            | Limit                                                         |
| ----------------- | ------------------------------------------------------------- |
| Login             | 20/min per IP; 15-minute lock after 10 failures in 15 minutes |
| Signup            | 5/h per IP, 3/h per email                                     |
| Reset request     | 5/h per IP, 3/h per email                                     |
| Reset submit      | 10/h per IP                                                   |
| Invitations       | 50/day per org, 5/day per address                             |
| Invitation accept | 10/h per IP                                                   |

A 429 includes `Retry-After`. Limits key on the resolved `request.ip`, which respects `TRUST_PROXY`.

## Errors

Envelope: `{ error: { code, message, requestId, details? } }`, where `requestId` is required in v0.2.

| Code                | Status | When                                                      |
| ------------------- | ------ | --------------------------------------------------------- |
| `VALIDATION_FAILED` | 400    | Schema validation failed (`details: [{ path, message }]`) |
| `BAD_REQUEST`       | 400    | Domain rule violation                                     |
| `AUTH_FAILED`       | 401    | Login failed (generic)                                    |
| `UNAUTHENTICATED`   | 401    | No or invalid session                                     |
| `CSRF_INVALID`      | 403    | CSRF token missing, mismatched or invalid                 |
| `FORBIDDEN`         | 403    | Origin not allowed, or CASL denial                        |
| `NOT_FOUND`         | 404    | Unknown or non-member org; invitation-accept failures     |
| `CONFLICT`          | 409    | Domain conflicts                                          |
| `RATE_LIMITED`      | 429    | Rate limit or lockout                                     |
| `INTERNAL`          | 500    | Unhandled error                                           |

`CSRF_INVALID` isn't in the contracts `ApiErrorCode` yet. The api extends the union locally (`apps/api/src/shared/api-error.ts`, with a TODO for Architecture to add it to contracts).
