# Auth, organizations and users API (P1-BE)

Source: `apps/api` on `integration/phase-1`. The modules were added by PR #27 (merged 2026-10-22 00:07 IST). Later changes:

- **#53**: Prisma repositories and the Redis limiter/lockout (merged 2026-10-24 14:04 IST).
- **#103**: the contracts v0.3.3 error envelope and `:organizationId` path params, per ADR-010 (merged 2026-10-24 17:24 IST).
- **#98**: atomic Redis lockout counters (merged 2026-10-24 17:26 IST).

Contracts come from `@meetops/contracts` (0.3.3 on `integration/phase-1`). See also `apps/api/README.md`.

> In-memory repositories, the in-memory rate limiter, the inline mail queue and the in-memory audit log are used **only when `NODE_ENV` is exactly `development` or `test`**. In any other environment (including unset), `createServer` throws `MissingProductionDependencyError` unless real implementations are injected and `WEB_ORIGINS` and `CSRF_SECRET` are set. The login lockout counts as provided when a Redis client is injected or `REDIS_URL` is set. Prisma implementations live under `apps/api/src/modules/*/infrastructure/prisma` (#53), but `start()` does not wire them yet; the caller injects them through `createServer({ deps })`.

## Endpoints

"Session" means a valid session cookie. Every POST, PATCH and DELETE also passes the Origin and CSRF guard (below). Path params use `organizationId`, the canonical tenant key from ADR-010.

| Method | Path                                                     | Auth           | Request                                                         | Response                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------- | -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                | Public         | None                                                            | 200 `{ status: 'ok' }`                                                                                                                                                                                   |
| GET    | `/ready`                                                 | Public         | None                                                            | 200 `{ status: 'ready' }`                                                                                                                                                                                |
| GET    | `/auth/csrf`                                             | Public         | None                                                            | 200 `{ csrfToken }`; sets the CSRF cookie (and a pre-session cookie if there's no session)                                                                                                               |
| POST   | `/auth/signup`                                           | Public         | `{ name, email, password }` (8–128, letter, number, and symbol) | 202 `{ message }`, same body whether or not the email exists; emails a verification link; no session                                                                                                     |
| POST   | `/auth/verify-email`                                     | Public         | `{ token }`                                                     | 204 (`x-meetops-verify-outcome` header); single-use token, 24-hour TTL. Outside the registering browser or the account's session, the password is removed and a set-password link is emailed (see below) |
| POST   | `/auth/resend-verification`                              | Public         | `{ email }`                                                     | 202 `{ message }` (enumeration-safe)                                                                                                                                                                     |
| POST   | `/auth/login`                                            | Public         | `{ email, password }` (password 1–128, no composition rules)    | 200 session response plus `csrfToken`; sets the session and CSRF cookies; 401 `AUTH_FAILED`; 429                                                                                                         |
| GET    | `/auth/providers`                                        | Public         | None                                                            | 200 `{ google: boolean }`. Booleans only; no client id or secret. `false` until all three `GOOGLE_OAUTH_*` vars are set                                                                                  |
| GET    | `/auth/google/start`                                     | Public         | `?next=` optional same-origin path                              | 302 to Google. Sets a 10-minute HttpOnly state cookie (PKCE verifier, nonce, state). 404 when Google sign-in is off                                                                                      |
| GET    | `/auth/google/callback`                                  | Public         | `code`, `state` from Google                                     | 302 to the web app with the session cookie, or to `/login?error=google` or `error=google_unverified`. 404 when off                                                                                       |
| POST   | `/auth/forgot-password`                                  | Public         | `{ email }`                                                     | 202 `{ message }` (enumeration-safe)                                                                                                                                                                     |
| POST   | `/auth/reset-password`                                   | Public         | `{ token, password }` (same 8–128 policy as signup)             | 204; single-use token, 30-minute TTL; revokes all of the user's sessions                                                                                                                                 |
| POST   | `/auth/logout`                                           | Session        | None                                                            | 204; revokes the session and clears the cookie                                                                                                                                                           |
| POST   | `/auth/logout-all`                                       | Session        | None                                                            | 204; revokes every session of the caller and clears the cookie                                                                                                                                           |
| GET    | `/auth/sessions`                                         | Session        | Cursor page query                                               | 200 cursor page of `{ id, current, createdAt, lastSeenAt, expiresAt, ip, userAgent }`                                                                                                                    |
| DELETE | `/auth/sessions/:sessionId`                              | Session        | None                                                            | 204; 404 for unknown sessions and other users' sessions; clears the cookie when it's the current session                                                                                                 |
| GET    | `/auth/session`                                          | Session        | None                                                            | 200 session response; slides the idle timeout; 401                                                                                                                                                       |
| GET    | `/orgs`                                                  | Session        | Cursor page query                                               | 200 cursor page of `{ organization, role }`                                                                                                                                                              |
| POST   | `/orgs`                                                  | Session        | `{ name }`                                                      | 201 `{ organization, role }`; creator becomes owner; session rotates                                                                                                                                     |
| GET    | `/orgs/:organizationId`                                  | Session        | None                                                            | 200 `{ organization, role }`; 404 for non-members                                                                                                                                                        |
| POST   | `/orgs/switch`                                           | Session        | `{ organizationId }`                                            | 200 `{ organization, role }`; 404 for non-members; session rotates                                                                                                                                       |
| POST   | `/orgs/:organizationId/invitations`                      | Session + CASL | `{ email, role: admin \| member \| viewer }`                    | 201 `Invitation` (same response for any address); 409 if the address is already an active member                                                                                                         |
| POST   | `/orgs/:organizationId/invitations/:invitationId/revoke` | Session + CASL | None                                                            | 200 `Invitation`; only pending invitations; cross-org 404                                                                                                                                                |
| POST   | `/invitations/accept`                                    | Session        | `{ token }`                                                     | 200 `{ organization, role }`; needs a verified email (403); every invalid token is the same 404; 409 if already a member                                                                                 |
| GET    | `/orgs/:organizationId/members`                          | Session        | Cursor page query                                               | 200 cursor page of members; `user.email` only for owners and admins                                                                                                                                      |
| PATCH  | `/orgs/:organizationId/members/:userId`                  | Session + CASL | `{ role }`                                                      | 200 `Membership`; 409 `LAST_OWNER`; revokes the target's sessions (your own role change rotates your session)                                                                                            |
| DELETE | `/orgs/:organizationId/members/:userId`                  | Session + CASL | None                                                            | 204; anyone may leave; 409 `LAST_OWNER`; revokes the removed user's sessions                                                                                                                             |

CASL rules: owners can do anything. Admins can invite, revoke, and change or remove members and viewers (only to member or viewer). Everyone else gets 403.

Lists use cursor pages: query `{ cursor?, limit? }` (default 25, max 100) and response `{ items, nextCursor }`.

The session response (`GetAuthSessionResponse`) is `{ user, organizations, memberships?, activeOrganizationId | null, role | null, expiresAt? }`. `activeOrganizationId` and `role` are both null or both set, and the server derives them from the membership. DTOs never include hashes or tokens. Request schemas reject unknown properties. Swagger UI is served at `/docs` only when `NODE_ENV` is exactly `development` or `test`.

Signup and reset passwords are 8–128 characters and must include a letter, a number, and a symbol (`Password` in `@meetops/contracts`). A space does not count as the symbol. Login uses a separate schema (1–128, no composition rules) so an existing password still signs in and the policy is not revealed on the login form.

### Google sign-in (web)

Full-page navigations, not JSON. Sign-up and log-in share one flow. The web app shows "Continue with Google" only when `GET /auth/providers` returns `{ google: true }`.

The start route seals the PKCE verifier, nonce, and state into `meetops_oauth` (`__Host-meetops_oauth` outside development), MACed with a key derived from `CSRF_SECRET` by HKDF-SHA256 (info `oauth-state`). The callback clears that cookie, exchanges the code, and checks the ID token (RS256, issuer, audience, `azp` required when there are several audiences, nonce, `exp`/`iat` with 60 s skew, `iat` at most 10 minutes old). The authorization code, ID token, verifier, and client secret never appear in the redirect back to the app. Failures use a fixed code (`google`, `google_unverified`, or `google_link_password`) and may keep a same-origin `next` path. Google's own error text is not forwarded.

"Proven" email: Google's `email_verified` is true **and** Google hosts the mailbox, i.e. the domain is `gmail.com` / `googlemail.com`, or the token's `hd` (Workspace) equals the email's domain. `email_verified` alone is not trusted for other domains.

Linking (`users.google_sub`, nullable, unique among live users):

- Match the Google `sub` first. Email is not the identity. An account already bound to another subject is never relinked.
- Proven email, verified account: link, sign out the account's other sessions, send an "account linked" email, audit `auth.google.linked`.
- Proven email, unverified account (possible pre-registration by someone else): in one database transaction drop its password, mark it verified, link the subject and revoke every session; then revoke extension tokens, push devices and one-time links, notify (the notice says the password was removed) and audit as above. If any step of the transaction fails, nothing changes and the next sign-in redoes the whole takeover.
- Unproven email, verified account: no auto-link. The browser lands on `/login?error=google_link_password` with a 10-minute HttpOnly `meetops_oauth_link` cookie (HKDF info `oauth-link`); the next successful password login of that same account in that browser links Google (other sessions are signed out, notice + audit).
- Unproven email, unverified account: refuse (`/login?error=google_unverified`). The web copy points to "Forgot password": a reset proves the mailbox, verifies the address, replaces any password someone else set and signs everyone else out.
- Nothing matches: create the account with no usable password. A proven email is verified and linked at once. An unproven email creates an **unverified, unlinked** account and a verification email; the subject waits in a 24-hour HttpOnly `meetops_oauth_vlink` cookie (HKDF info `oauth-verify-link`) and is linked only when the verification link is opened in that same browser while its Google session is live. Org creation and invitation acceptance stay gated until then (D2).
- A Google account whose email is not verified never creates or links a user.

Google sessions are stored with `auth_level = google`.

### Who owns an account that was never verified

Verifying (`POST /auth/verify-email`) or resetting the password proves the mailbox, not who chose the password. So:

- **Verify from the registering browser or the account's own live session**: signup sets a 24-hour HttpOnly, SameSite=Strict `meetops_sid_signup` cookie (HKDF info `signup-binding`; a taken email gets one of the same shape). Verifying with it, or inside a live session of the account, marks the email verified, signs out the account's other sessions and keeps the password.
- **Verify from anywhere else**: the mailbox owner takes the account over. In one transaction the email is marked verified, the password and any Google link are removed and every session is revoked; then extension tokens, push devices and one-time links are revoked (each step retried; a step that still fails gives 503, as does a failed transaction) and a set-password link is emailed through the regular reset flow. The response is still 204, with `x-meetops-verify-outcome: password_reset` (otherwise `verified`) so the web page can say the password was removed; only the token holder sees it.
- **Password reset** of an unverified account marks it verified and removes any Google link made before the address was proven (the new password stays).
- **Sign-ins already in flight** (OIDC review X4): password login, Google sign-in and session rotation re-read the account's credentials after the new session row is written (Postgres `SELECT … FOR SHARE`, which waits for an uncommitted takeover). If the password, Google link or verification state they relied on changed, the new session is revoked and the request gets the generic 401. A takeover that commits later revokes the row inside its own transaction. A login-time rehash only replaces the hash it verified (compare-and-set).

Residual risk (OIDC review N-1 / Architecture B-1, PR #459): a legitimate user who opens the verification email on a different device (no signup cookie, not signed in there) also loses the password they chose and has to set a new one from the emailed link. That is the price of not letting a squatter keep a password on an address they never proved. Accounts verified **before** this change keep whatever password they had; if one was pre-registered by someone else and verified by the owner before this change, the squatter's password still works until the owner resets it. Linking Google to an already-verified account signs out its other sessions but does not remove the password, and a password reset does not remove a Google link made after the address was proven.

Rate limit: 20 flows per minute per IP, charged once by the start route. The callback refuses a missing, forged or expired state cookie before charging anything, and each state completes at most one callback. A request with no client IP is refused rather than sharing an `unknown` bucket. A limit failure redirects to `/login?error=google`.

The extension pairing endpoints (`/auth/extension/pair`, `/auth/extension-token`, `/auth/extension/refresh`, `/auth/extension/revoke`) are defined in contracts (`EXTENSION_AUTH_PATHS`, ADR-005) but `apps/api` doesn't implement them yet.

## Cookies

| Cookie              | Production                   | `NODE_ENV=development` | Flags                                                                   |
| ------------------- | ---------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Session             | `__Host-meetops_sid`         | `meetops_sid`          | HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h, no Domain                 |
| CSRF                | `__Host-meetops_csrf`        | `meetops_csrf`         | Readable by JS, SameSite=Lax, Path=/                                    |
| Pre-session nonce   | `__Host-meetops_presession`  | `meetops_presession`   | HttpOnly, SameSite=Lax, Path=/                                          |
| Google OAuth state  | `__Host-meetops_oauth`       | `meetops_oauth`        | HttpOnly, SameSite=Lax, Path=/, Max-Age 10 min; cleared on the callback |
| Pending Google link | `__Host-meetops_oauth_link`  | `meetops_oauth_link`   | HttpOnly, SameSite=Lax, Path=/, Max-Age 10 min; cleared on login        |
| Google verify link  | `__Host-meetops_oauth_vlink` | `meetops_oauth_vlink`  | HttpOnly, SameSite=Lax, Path=/, Max-Age 24 h; cleared on verify         |
| Signup binding      | `__Host-meetops_sid_signup`  | `meetops_sid_signup`   | HttpOnly, SameSite=Strict, Path=/, Max-Age 24 h; cleared on verify      |

- Every environment except `development` uses the `__Host-` prefix plus `Secure`, and that's asserted at startup. Development over plain http drops both, because browsers refuse them on `http://localhost`.
- Session tokens are opaque 256-bit values stored as SHA-256 hashes.
- Sessions have a 30-minute sliding idle timeout and a 12-hour absolute timeout, and they rotate on login, org create and org switch.

## CSRF flow

1. `GET /auth/csrf` returns `{ csrfToken }` and sets the CSRF cookie. The token is `nonce.HMAC-SHA256(CSRF_SECRET, "<binding>.<nonce>")`. The binding is `s:<sessionId>` when there's a session; otherwise it's `p:<nonce>`, taken from a new HttpOnly pre-session cookie.
2. Every POST, PUT, PATCH or DELETE must send `X-CSRF-Token` equal to the CSRF cookie, and the HMAC must verify against the request's current binding. A token from another session, a stale pre-session token after login, or a forged token is rejected.
3. Login returns a fresh `csrfToken`. Org create and switch refresh the cookie. Clients re-fetch after logout.
4. `Origin` (or `Referer` as a fallback) must be in `WEB_ORIGINS`. Requests with neither are rejected.

## Configuration

| Variable                                                                            | Notes                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | Only exactly `development` or `test` relax the checks                                                                                                                                                                                                                                                                                    |
| `WEB_ORIGINS`                                                                       | Comma-separated allowlist; required in production; dev default `http://localhost:5173,http://localhost:3000`                                                                                                                                                                                                                             |
| `CSRF_SECRET`                                                                       | HMAC key, at least 32 bytes; required in production; random per process in dev and test                                                                                                                                                                                                                                                  |
| `TRUST_PROXY`                                                                       | Comma list of proxy IPs/CIDRs (hop count dev/test only, fails in production); `true` and `/0` are rejected; default off                                                                                                                                                                                                                  |
| `PORT` / `HOST`                                                                     | Default `3000` / `0.0.0.0`                                                                                                                                                                                                                                                                                                               |
| `WEB_BASE_URL`                                                                      | Browser origin for email links and the redirect after Google sign-in. Its origin must be in `WEB_ORIGINS`                                                                                                                                                                                                                                |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Set all three or none. The redirect URI is absolute, has no query or fragment, and its path ends with `/auth/google/callback`. Production requires `https`. Development may use `http://localhost`. With the Vite `/api` proxy the browser hits `http://localhost:5173/api/auth/google/callback`. This client is not `GOOGLE_CALENDAR_*` |

## Rate limits and lockout

| Action              | Limit                                                                  |
| ------------------- | ---------------------------------------------------------------------- |
| Login               | 20/min per IP; 15-minute lock after 10 failures in 15 minutes          |
| Google sign-in      | 20/min per IP, charged by the start route only; one callback per state |
| Signup              | 5/h per IP, 3/h per email                                              |
| Reset request       | 5/h per IP, 3/h per email                                              |
| Reset submit        | 10/h per IP                                                            |
| Verify email        | 10/h per IP                                                            |
| Resend verification | 5/h per IP, 3/h per email                                              |
| Invitations         | 50/day per org, 5/day per address                                      |
| Invitation accept   | 10/h per IP                                                            |

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
