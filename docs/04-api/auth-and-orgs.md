# Auth, organizations and users API (P1-BE)

> **Note:** This page describes the auth, organizations and users modules from **PR #27** (`feat/api-auth-orgs`), merged into `integration/phase-1` on 2026-10-22 00:07 IST (2026-10-21 18:37Z). Contracts now come from the `@meetops/contracts` workspace package; the old `apps/api/src/shared/contracts` mirror is gone. In-memory repositories are still present on `integration/phase-1`, and Prisma/Redis persistence is Backend PR #53 (open), so this isn't production-safe yet.

## Endpoints

"Session" means a valid session cookie (`requireSession`). Every POST also needs CSRF and Origin checks (next section).

| Method | Path                                         | Auth           | Request                                       | Response                                                                                                |
| ------ | -------------------------------------------- | -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/csrf`                                 | Public         | None                                          | 200 `{ csrfToken }`; sets the CSRF cookie                                                               |
| POST   | `/auth/signup`                               | Public         | `{ name, email, password }` (password 12–128) | 202 `{ message }`; same body whether or not the email exists; no session                                |
| POST   | `/auth/login`                                | Public         | `{ email, password }`                         | 200 `SessionResponse`; sets the session cookie; generic 401 on failure; 429 when rate-limited or locked |
| POST   | `/auth/forgot-password`                      | Public         | `{ email }`                                   | 202 `{ message }` (enumeration-safe)                                                                    |
| POST   | `/auth/reset-password`                       | Public         | `{ token, password }` (12–128)                | 204; revokes all of the user's sessions                                                                 |
| POST   | `/auth/logout`                               | Session        | None                                          | 204; clears the session cookie                                                                          |
| GET    | `/auth/session`                              | Session        | None                                          | 200 `SessionResponse`; 401 if none                                                                      |
| GET    | `/orgs`                                      | Session        | None                                          | 200 `Paginated<{ organization, role }>`                                                                 |
| POST   | `/orgs`                                      | Session        | `{ name }`                                    | 201 `{ organization, role }`; creator becomes owner; session rotates                                    |
| GET    | `/orgs/:id`                                  | Session        | None                                          | 200 `{ organization, role }`; 404 for non-members (same as unknown)                                     |
| POST   | `/orgs/switch`                               | Session        | `{ organizationId }`                          | 200 `{ organization, role }`; session rotates                                                           |
| POST   | `/orgs/:id/invitations`                      | Session + CASL | `{ email, role: admin \| member \| viewer }`  | 201 `Invitation` (same response for any address); 403 member, 404 outsider                              |
| POST   | `/orgs/:id/invitations/:invitationId/revoke` | Session + CASL | None                                          | 200 `Invitation`; cross-org 404                                                                         |
| POST   | `/invitations/accept`                        | Session        | `{ token }`                                   | 200 `{ organization, role }`; every failure is the same 404                                             |

Shapes:

- `SessionResponse`: `{ user, organizations, memberships, activeOrganizationId: string | null, expiresAt, idleExpiresAt }`.
- `Invitation`: `{ id, organizationId, email, role, status, expiresAt }`.
- DTOs never include hashes or tokens. `/health` is unchanged.

Not in this PR: meetings, tasks, projects and uploads endpoints.

## Cookies

| Cookie  | Name (production)     | Name (`NODE_ENV=development`) | Flags                                                                        |
| ------- | --------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Session | `__Host-meetops_sid`  | `meetops_sid`                 | HttpOnly, Secure (not in dev), SameSite=Lax, Path=/, no Domain, Max-Age 12 h |
| CSRF    | `__Host-meetops_csrf` | `meetops_csrf`                | **Not** HttpOnly (JS reads it), Secure (not in dev), SameSite=Lax, Path=/    |

- Session tokens are opaque 256-bit values, stored only as SHA-256 hashes.
- Sessions have a 30-minute sliding idle timeout and a 12-hour absolute timeout.
- Sessions rotate on login, org create and org switch; the CSRF cookie is unaffected.

## CSRF flow

1. `GET /auth/csrf` returns `{ csrfToken }` and sets the CSRF cookie to the same value.
2. On every POST, PUT, PATCH or DELETE, send `X-CSRF-Token: <csrfToken>` with `credentials: 'include'`. The header must equal the cookie (double-submit).
3. The `Origin` header (falling back to `Referer`; missing both is rejected) must be in `WEB_ORIGINS`, which is comma-separated and defaults to `http://localhost:3000`.
4. Failures return 403 in the error envelope.

The PR notes this is plain double-submit, not HMAC-bound to the session, and flags it for Security review.

## Rate limits and lockout

| Action        | Limit                                           |
| ------------- | ----------------------------------------------- |
| Login         | 20/min per IP; 15-minute lock after 10 failures |
| Signup        | 5/h per IP, 3/h per email                       |
| Reset request | 5/h per IP, 3/h per email                       |
| Reset submit  | 10/h                                            |
| Invites       | 50/day per org, 5/day per address               |
| Accept        | 10/h per IP                                     |

A 429 includes `Retry-After`.

## Errors

Envelope: `{ error: { code, message, requestId, details? } }` (contracts `ApiErrorEnvelope`). Validation errors carry `details: [{ path, message }]`.

| Code                | Status | When                                                  |
| ------------------- | ------ | ----------------------------------------------------- |
| `VALIDATION_FAILED` | 400    | Schema validation failed                              |
| `BAD_REQUEST`       | 400    | Domain rule violation                                 |
| `UNAUTHENTICATED`   | 401    | No or invalid session; failed login (generic)         |
| `FORBIDDEN`         | 403    | CSRF or Origin failure; CASL denial for members       |
| `NOT_FOUND`         | 404    | Unknown or non-member org; invitation-accept failures |
| `CONFLICT`          | 409    | Domain conflicts                                      |
| `RATE_LIMITED`      | 429    | Rate limit or lockout (with `Retry-After`)            |
| `INTERNAL`          | 500    | Unhandled error (only name and message are logged)    |

`PROVIDER_UNAVAILABLE` exists in the code union but isn't used by these routes.
