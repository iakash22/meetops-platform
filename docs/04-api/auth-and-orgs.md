# Auth, organizations and users API (P1-BE)

Source: `apps/api` on `integration/phase-1`. The modules were added by PR #27 (merged 2026-10-22 00:07 IST). Later changes:

- **#53**: Prisma repositories and the Redis limiter/lockout (merged 2026-10-24 14:04 IST).
- **#103**: the contracts v0.3.3 error envelope and `:organizationId` path params, per ADR-010 (merged 2026-10-24 17:24 IST).
- **#98**: atomic Redis lockout counters (merged 2026-10-24 17:26 IST).

Contracts come from `@meetops/contracts` (0.3.3 on `integration/phase-1`). See also `apps/api/README.md`.

> In-memory repositories, the in-memory rate limiter, the inline mail queue and the in-memory audit log are used **only when `NODE_ENV` is exactly `development` or `test`**. In any other environment (including unset), `createServer` throws `MissingProductionDependencyError` unless real implementations are injected and `WEB_ORIGINS` and `CSRF_SECRET` are set. The login lockout counts as provided when a Redis client is injected or `REDIS_URL` is set. Prisma implementations live under `apps/api/src/modules/*/infrastructure/prisma` (#53), but `start()` does not wire them yet; the caller injects them through `createServer({ deps })`.

## Endpoints

"Session" means a valid session cookie. Every POST, PATCH and DELETE also passes the Origin and CSRF guard (below). Path params use `organizationId`, the canonical tenant key from ADR-010.

| Method | Path                                                     | Auth           | Request                                                         | Response                                                                                                                 |
| ------ | -------------------------------------------------------- | -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/health`                                                | Public         | None                                                            | 200 `{ status: 'ok' }`                                                                                                   |
| GET    | `/ready`                                                 | Public         | None                                                            | 200 `{ status: 'ready' }`                                                                                                |
| GET    | `/auth/csrf`                                             | Public         | None                                                            | 200 `{ csrfToken }`; sets the CSRF cookie (and a pre-session cookie if there's no session)                               |
| POST   | `/auth/signup`                                           | Public         | `{ name, email, password }` (8–128, letter, number, and symbol) | 202 `{ message }`, same body whether or not the email exists; emails a verification link; no session                     |
| POST   | `/auth/verify-email`                                     | Public         | `{ token }`                                                     | 204; single-use token, 24-hour TTL                                                                                       |
| POST   | `/auth/resend-verification`                              | Public         | `{ email }`                                                     | 202 `{ message }` (enumeration-safe)                                                                                     |
| POST   | `/auth/login`                                            | Public         | `{ email, password }`                                           | 200 session response plus `csrfToken`; sets the session and CSRF cookies; 401 `AUTH_FAILED`; 429                         |
| POST   | `/auth/forgot-password`                                  | Public         | `{ email }`                                                     | 202 `{ message }` (enumeration-safe)                                                                                     |
| POST   | `/auth/reset-password`                                   | Public         | `{ token, password }`                                           | 204; single-use token, 30-minute TTL; revokes all of the user's sessions                                                 |
| POST   | `/auth/logout`                                           | Session        | None                                                            | 204; revokes the session and clears the cookie                                                                           |
| POST   | `/auth/logout-all`                                       | Session        | None                                                            | 204; revokes every session of the caller and clears the cookie                                                           |
| GET    | `/auth/sessions`                                         | Session        | Cursor page query                                               | 200 cursor page of `{ id, current, createdAt, lastSeenAt, expiresAt, ip, userAgent }`                                    |
| DELETE | `/auth/sessions/:sessionId`                              | Session        | None                                                            | 204; 404 for unknown sessions and other users' sessions; clears the cookie when it's the current session                 |
| GET    | `/auth/session`                                          | Session        | None                                                            | 200 session response; slides the idle timeout; 401                                                                       |
| GET    | `/orgs`                                                  | Session        | Cursor page query                                               | 200 cursor page of `{ organization, role }`                                                                              |
| POST   | `/orgs`                                                  | Session        | `{ name }`                                                      | 201 `{ organization, role }`; creator becomes owner; session rotates                                                     |
| GET    | `/orgs/:organizationId`                                  | Session        | None                                                            | 200 `{ organization, role }`; 404 for non-members                                                                        |
| POST   | `/orgs/switch`                                           | Session        | `{ organizationId }`                                            | 200 `{ organization, role }`; 404 for non-members; session rotates                                                       |
| POST   | `/orgs/:organizationId/invitations`                      | Session + CASL | `{ email, role: admin \| member \| viewer }`                    | 201 `Invitation` (same response for any address); 409 if the address is already an active member                         |
| POST   | `/orgs/:organizationId/invitations/:invitationId/revoke` | Session + CASL | None                                                            | 200 `Invitation`; only pending invitations; cross-org 404                                                                |
| POST   | `/invitations/accept`                                    | Session        | `{ token }`                                                     | 200 `{ organization, role }`; needs a verified email (403); every invalid token is the same 404; 409 if already a member |
| GET    | `/orgs/:organizationId/members`                          | Session        | Cursor page query                                               | 200 cursor page of members; `user.email` only for owners and admins                                                      |
| PATCH  | `/orgs/:organizationId/members/:userId`                  | Session + CASL | `{ role }`                                                      | 200 `Membership`; 409 `LAST_OWNER`; revokes the target's sessions (your own role change rotates your session)            |
| DELETE | `/orgs/:organizationId/members/:userId`                  | Session + CASL | None                                                            | 204; anyone may leave; 409 `LAST_OWNER`; revokes the removed user's sessions                                             |

CASL rules: owners can do anything. Admins can invite, revoke, and change or remove members and viewers (only to member or viewer). Everyone else gets 403.

Lists use cursor pages: query `{ cursor?, limit? }` (default 25, max 100) and response `{ items, nextCursor }`.

The session response (`GetAuthSessionResponse`) is `{ user, organizations, memberships?, activeOrganizationId | null, role | null, expiresAt? }`. `activeOrganizationId` and `role` are both null or both set, and the server derives them from the membership. DTOs never include hashes or tokens. Request schemas reject unknown properties. Swagger UI is served at `/docs` only when `NODE_ENV` is exactly `development` or `test`.

The extension pairing endpoints (`/auth/extension/pair`, `/auth/extension-token`, `/auth/extension/refresh`, `/auth/extension/revoke`) are defined in contracts (`EXTENSION_AUTH_PATHS`, ADR-005) but `apps/api` doesn't implement them yet.

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

| Variable        | Notes                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`      | Only exactly `development` or `test` relax the checks                                                                   |
| `WEB_ORIGINS`   | Comma-separated allowlist; required in production; dev default `http://localhost:5173,http://localhost:3000`            |
| `CSRF_SECRET`   | HMAC key, at least 32 bytes; required in production; random per process in dev and test                                 |
| `TRUST_PROXY`   | Comma list of proxy IPs/CIDRs (hop count dev/test only, fails in production); `true` and `/0` are rejected; default off |
| `PORT` / `HOST` | Default `3000` / `0.0.0.0`                                                                                              |

## Rate limits and lockout

| Action              | Limit                                                         |
| ------------------- | ------------------------------------------------------------- |
| Login               | 20/min per IP; 15-minute lock after 10 failures in 15 minutes |
| Signup              | 5/h per IP, 3/h per email                                     |
| Reset request       | 5/h per IP, 3/h per email                                     |
| Reset submit        | 10/h per IP                                                   |
| Verify email        | 10/h per IP                                                   |
| Resend verification | 5/h per IP, 3/h per email                                     |
| Invitations         | 50/day per org, 5/day per address                             |
| Invitation accept   | 10/h per IP                                                   |

A 429 includes `Retry-After`. Limits key on the resolved `request.ip`, which respects `TRUST_PROXY`. The login lockout uses Redis (atomic counters, #98) when a client is injected or `REDIS_URL` is set outside `NODE_ENV=test`; otherwise it's in memory (development and test only).

## Errors

Envelope (contracts `ApiErrorEnvelope`, v0.3.3): `{ error: { code, message, requestId, details?, reason? } }`. `requestId` is always present. `reason` names the cause of a `CONFLICT`: `ALREADY_MEMBER`, `INVITATION_EXPIRED`, `INVITATION_REVOKED`, `INVITATION_ALREADY_ACCEPTED`, `LAST_OWNER`, `EMAIL_TAKEN` or the generic `CONFLICT`.

| Code                | Status | When                                                      |
| ------------------- | ------ | --------------------------------------------------------- |
| `VALIDATION_FAILED` | 400    | Schema validation failed (`details: [{ path, message }]`) |
| `BAD_REQUEST`       | 400    | Domain rule violation                                     |
| `AUTH_FAILED`       | 401    | Login failed (generic)                                    |
| `UNAUTHENTICATED`   | 401    | No or invalid session                                     |
| `CSRF_INVALID`      | 403    | CSRF token missing, mismatched or invalid                 |
| `FORBIDDEN`         | 403    | Origin not allowed, CASL denial, or unverified email      |
| `NOT_FOUND`         | 404    | Unknown or non-member org; invitation-accept failures     |
| `CONFLICT`          | 409    | Domain conflicts, with `reason`                           |
| `RATE_LIMITED`      | 429    | Rate limit or lockout                                     |
| `INTERNAL`          | 500    | Unhandled error                                           |

`CSRF_INVALID` is part of the contracts `ApiErrorCode` since v0.3.0 (#50); the api no longer extends the union locally. The client should `GET /auth/csrf` and retry once. `PROVIDER_UNAVAILABLE` is also in the union but these routes don't use it.
