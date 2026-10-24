# ADR-006: Login lockout and one-time tokens

- Status: Proposed
- Date: 2026-10-24
- Owner: Architecture Agent (ARCH), with the Security (SEC) and Backend (BE) Agents
- Implementing PR: #53 (`feat(api): P1-BE-2 persistence ...`), **open and unmerged**, verified at head
  `ce3eedced2b7fea995459f28441640b6b68727e5`
- Related: [ADR-005](./ADR-005-extension-auth.md), `docs/12-security/auth-session-spec.md` §5

## Context

Password login needs brute-force protection that does not reveal whether an account exists. Email verification and
password reset both need single-use, expiring tokens. The code lives in `apps/api/src/modules/auth`.

## Decision

1. **Policy** (`infrastructure/rate-limit/lockout-policy.ts`, `DEFAULT_LOCKOUT`): a 15-minute failure window
   (`windowMs`), `delayThreshold: 5`, `lockThreshold: 10`, `baseDelayMs: 100`, `maxDelayMs: 1000`, `lockMs: 15 min`.
   - Failures 1–4 in the window: no delay.
   - Failures 5–9: progressive delay of 100, 200, 400, 800 and 1000 ms (doubling, capped). The response is still the
     generic 401.
   - Failure 10: a temporary 15-minute lock (never permanent). That failure has no extra delay, and the failure count
     restarts once the lock is applied.
   - A locked key gets `RateLimitedError` (with `retryAfterMs`) before the password is checked.
   - A successful login, and a successful password reset, reset the lockout for that email.
2. **Key.** `AuthService.login` keys the lockout by `normalizeEmail(email)` whether or not the account exists. For
   unknown emails it still runs `hasher.verify` against a dummy hash, so timing and lockout behaviour are the same
   (enumeration-safe). Failures are audited as `auth.login.failure` and locks as `auth.lockout`.
3. **Per-IP limiting is separate.** `RateLimiter` (fixed window) runs `login:ip:<ip>` at 20 per minute
   (`AUTH_LIMITS.loginPerIp`) before the lockout check. `AUTH_LIMITS` also covers signup, reset request/submit, verify
   and resend, per IP and (for signup, reset request and resend) per email.
4. **Implementations.** `InMemoryRateLimiter`/`InMemoryLoginLockout` (dev/test, process-local) and
   `RedisRateLimiter`/`RedisLoginLockout` (shared across instances) implement the same policy.
5. **One-time tokens** (`domain/one-time-token.ts`) replace the old `password-reset.ts` and its in-memory repository,
   which this PR deletes. One `OneTimeToken` model has `purpose: 'email_verification' | 'password_reset'`. Only
   SHA-256 of the token is stored; the raw token exists only in the email. `consume` is atomic single use (contract:
   `UPDATE ... WHERE used_at IS NULL AND expires_at > now RETURNING`). `setTokenHash` lets the mail worker mint the
   real token and invalidate earlier links, and `invalidateForUser` revokes outstanding tokens of a purpose. Adapters:
   in-memory, Prisma, and Redis (`redis-one-time-token.repository.ts`, an interim store using `GETDEL` on the hash
   index for single use).

## Consequences and known gaps

- **Redis isn't wired.** `defaultModuleDeps` uses the in-memory limiter, lockout and one-time-token store by default
  (marked TODO(database)/TODO(infra)). Outside `NODE_ENV` `development`/`test` the API refuses to start unless
  `rateLimiter`, `lockout`, `oneTimeTokens` and the other `PRODUCTION_REQUIRED_DEPS` are injected
  (`MissingProductionDependencyError`), so production can't silently fall back to in-memory, but nothing injects the
  Redis classes yet.
- **`INCR` + `PEXPIRE` isn't atomic** in `RedisRateLimiter` and `RedisLoginLockout`. A crash between them can leave a
  key without a TTL. The rate limiter self-heals (re-applies `PEXPIRE` when `PTTL < 0` on a denied request); the
  lockout failure counter does not. A Lua script or `SET NX PX` + `INCR` would fix this.
- **The lockout notice email is a TODO** (`TODO(notifications #11)`). The lock is audited only.
- The spec's 10-failure rule counts failures in a 15-minute window, so slow guessing below that rate is limited only by
  the per-IP limiter.
