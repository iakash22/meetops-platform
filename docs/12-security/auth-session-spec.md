# Auth and session spec (Backend)

## 1. Passwords

- Hash: **argon2id**, minimum OWASP params `m=19456 KiB (19 MiB), t=2, p=1`; target higher if latency budget allows (benchmark ~ 50–250 ms). Store full PHC string (params + salt) so params can be upgraded; rehash on login when params are outdated.
- 16-byte random salt; optional pepper from secret manager (HMAC before hashing) — see open questions.
- Policy: min 8 chars, max 128, must include a letter, a number, and a symbol (enforced in `@meetops/contracts` as `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` / `PASSWORD_PATTERN`: at least one letter `[A-Za-z]`, one digit, and one symbol that is not a letter, digit, or space; no newlines). Login accepts any non-empty password up to 128 so existing passwords still sign in. Check against a breached-password list (k-anonymity HIBP or a local list) is not implemented yet.
- **Owner decision (Akash, 9 Nov 2026):** keep the 8-character minimum with the composition rules above. Do not raise the minimum. This supersedes the 12-character rule from the PR #17 review. Policy values in code stay unchanged.
- Library: `argon2` (node) in Fastify auth module.

## 2. Sessions

- Opaque, server-side sessions: 256-bit random token from CSPRNG; store only `SHA-256(token)` in `sessions` table (or Redis) with `user_id, org_id (active), created_at, last_seen_at, expires_at, ip, user_agent, auth_level`.
- No JWTs in browser storage; nothing in `localStorage`.
- **Rotation**: issue new session id on login, logout→revoke, on privilege change (role change, org switch, MFA step-up, password change). Password change/reset revokes all other sessions.
- **Timeouts**: idle 30 min (sliding, `last_seen_at`), absolute 12 h (configurable per org, max 7 days for "remember me" if adopted).
- Users can list and revoke sessions; admins can revoke members' sessions.

## 3. Cookie

```http
Set-Cookie: __Host-meetops_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax
```

- `__Host-` prefix requires Secure, Path=/, no Domain. Dev over http: use `meetops_sid` without prefix only when `NODE_ENV=development`.
- Use `@fastify/cookie`; no `Max-Age` beyond absolute timeout.

## 4. CSRF

- Synchronizer token: per-session random CSRF token stored server-side, delivered via `GET /auth/csrf` (or non-HttpOnly `__Host-meetops_csrf` for double-submit, HMAC-bound to session id). Required in `X-CSRF-Token` header on all non-GET/HEAD/OPTIONS.
- Plus Origin check: reject state-changing requests whose `Origin` (fallback `Referer`) is not in allowlisted web origins. Missing both → reject.
- SameSite=Lax is defense in depth, not the control. GET must never mutate.
- CORS: explicit origin allowlist, `credentials: true`, no wildcard.

## 5. Rate limits and lockout

Using `@fastify/rate-limit` with Redis store; keys by IP and by normalized account identifier.

| Endpoint               | Per IP         | Per account/email                                                                  | Other                                                                  |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Login                  | 20/min         | 5 failures / 15 min → progressive delay; 10 → temporary lock 15 min + email notice | No permanent lockout (DoS); CAPTCHA after threshold                    |
| Signup                 | 5/hour         | 3/hour per email                                                                   | Email verification required before org data access                     |
| Password reset request | 5/hour         | 3/hour                                                                             | Token: 256-bit, single use, hashed at rest, 30 min TTL                 |
| Reset submit           | 10/hour        | —                                                                                  | Revoke all sessions on success                                         |
| Invite send            | 50/day per org | 5/day per address                                                                  | Invite token single-use, 7-day TTL, bound to email + org               |
| Invite accept          | 10/hour        | —                                                                                  | Must match invited email                                               |
| Google sign-in (web)   | 20/min         | —                                                                                  | Start and callback share one budget. Off until `GOOGLE_OAUTH_*` is set |

## 6. Enumeration-safe responses

- Login failure: generic "Invalid email or password", same status/timing (run dummy argon2 verify for unknown users).
- Signup with existing email: same response "Check your email"; send "you already have an account" mail.
- Reset: always "If an account exists, we sent a link".
- Invite accept / org lookups: 404 for unknown and unauthorized alike.

## 7. Audit

Log (without secrets) login success/failure, lockout, reset, session revoke, role change, MFA changes to `audit_events`.

## 8. Google sign-in (web)

Shipped 2026-11-07 for the web app. Authorization code + PKCE, server-side code exchange, ID token checks (audience, nonce, verified email). No Google refresh token is stored. Account linking is by `users.google_sub`, not by email alone: a verified local account can be linked; an unverified local email is refused. Mobile, desktop, and the extension do not start this flow. Calendar OAuth is a different client (`GOOGLE_CALENDAR_*`).

## 9. Future

Decided in [ADR-021](../15-decisions/ADR-021-mfa-sso.md) (approved 2026-11-01) and not built yet: MFA (TOTP and WebAuthn passkeys, recovery codes) required for owners/admins, and step-up via `auth_level`. SAML/OIDC SSO per org is deferred to the first enterprise deal (Enterprise plan only).
