# MFA security test plan (ADR-021)

- Status: **Ready for implementation. MFA is not built yet.** Refreshed against `integration/phase-1` at `6feef782` (2026-11-11, Asia/Calcutta).
- Owner: Tester & Security (ADR-021 "tests by Tester & Security"). The implementer is All Rounder Techy (Architecture).
- Sources:
  - [ADR-021](../15-decisions/ADR-021-mfa-sso.md) (accepted 2026-11-01; fetched from `integration/phase-1` at `6feef782`)
  - [`auth-session-spec.md`](./auth-session-spec.md) §2, §4, §5, §6, §7, §8 and §9
  - [ADR-006](../15-decisions/ADR-006-login-lockout-one-time-tokens.md) (lockout)
  - [ADR-016](../15-decisions/ADR-016-secret-manager-kms.md) / [ADR-008](../15-decisions/ADR-008-oauth-pkce-token-encryption.md) (`TokenCipher`)
  - [ADR-005](../15-decisions/ADR-005-extension-auth.md), [ADR-012](../15-decisions/ADR-012-desktop-auth.md) and [ADR-014](../15-decisions/ADR-014-geoip-session-location.md) §37 (step-up window)
  - [`threat-model.md`](./threat-model.md) §3.7
  - The Google OIDC review of integration `c60fadcf` (findings N-1 to N-6, M-2) and the account-claim work merged in #463
- Executable suite: `apps/api/test/mfa.security.test.ts`. Cases are indexed in [`test-cases.md`](./test-cases.md) §5. Playwright coverage belongs under `tests/e2e/`. Live Postgres/Redis gates use the usual `flock` + `vitest --maxWorkers=2` path against `mo425-pg` / `mo425-redis`.

This revision keeps every existing `MFA-*` id, updates the baseline to `6feef782`, and adds takeover/claims cases, migration/backfill cases, a layer (unit / integ / live-pg / live-redis / e2e / manual) and priority (P0 / P1 / P2) on each case, and release gates. It does not invent ADR-021 requirements; anything the ADR does not say is tagged **[REC]** or **OQ-n**.

## 0. How to read this plan

Every requirement below is tagged with where it comes from. Only **[ADR]** items are decided.

| Tag        | Meaning                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **[ADR]**  | Stated in ADR-021.                                                                                                                  |
| **[SPEC]** | Stated in an existing spec or ADR (`auth-session-spec.md`, ADR-005/006/011/012/014/016). It applies to MFA as written.              |
| **[REC]**  | Recommended by Security/QA (industry practice: RFC 6238, WebAuthn L2, OWASP ASVS V2/V3). Not decided. Owner to confirm.             |
| **OQ-n**   | ADR-021 does not say. This is an open question for the owner (§14). Cases that depend on it use the recommended default and say so. |

Priority is the release bar, not a restatement of impact:

| Pri    | Meaning                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | Ship-blocking. A failure is account takeover or MFA bypass, or it is an ADR-021 control that must work before MFA is enabled anywhere. All P0 unit, integ, live-pg and live-redis cases are a merge/staging gate. |
| **P1** | Required before production. High-severity remaining ADR/SPEC items, and the [REC] items that close a known bypass class.                                                                                          |
| **P2** | Defence in depth, hygiene, or blocked on an open question / manual tabletop. Should not slip indefinitely, but does not hold the first staging enablement by itself.                                              |

Severity (still shown) is the impact **if the control is missing or broken**: Critical (account takeover or MFA bypass at scale), High (bypass for one account, or loss of a sensitive secret), Medium (weakened control, needs another bug to exploit), Low (defence in depth, hygiene).

Layer is where the case should run. A case can list more than one; the first is the primary automation.

| Layer          | Meaning                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **unit**       | Pure functions, schema assertions, logger, `TokenCipher`, lockout policy. No HTTP app.                                  |
| **integ**      | `apps/api` vitest with in-memory or injected fakes (Fastify inject). No live Postgres/Redis.                            |
| **live-pg**    | Against real Postgres (`mo425-pg`) with RLS and the migrated schema.                                                    |
| **live-redis** | Against real Redis (`mo425-redis`): shared lockout/rate-limit, fail-closed behaviour.                                   |
| **e2e**        | Playwright under `tests/e2e/` (web). Desktop/extension/mobile have their own e2e trees when those clients are in scope. |
| **manual**     | Real authenticators, support runbook, statistical timing. Not a CI skip of a P0.                                        |

Threat-model links refer to rows in [`threat-model.md`](./threat-model.md) §3.7:

| Label    | Row                                                                             |
| -------- | ------------------------------------------------------------------------------- |
| TM-S     | S: credential stuffing, session theft                                           |
| TM-T     | T: CSRF on state-changing calls                                                 |
| TM-I     | I: IDOR / cross-tenant reads                                                    |
| TM-D     | D: API abuse (rate limits)                                                      |
| TM-E     | E: role escalation                                                              |
| TM-R     | R: missing audit                                                                |
| TM-MFA-S | S: phished password or stolen session used for owner/admin or sensitive actions |
| TM-MFA-T | T/E: MFA bypass by replay, downgrade, or disable/reset/recovery abuse           |
| TM-MFA-I | I: TOTP secret or recovery codes leaked from the DB or logs                     |

## 1. What ADR-021 decides (and what exists today at `6feef782`)

| #   | ADR-021 decision                                                                                                                  | State in code at `integration/phase-1` `6feef782`                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | In-house MFA: **TOTP**, **WebAuthn passkeys**, **single-use hashed recovery codes**                                               | Not built. No `/auth/mfa*` route, no factor tables.                                                                                                                                                                                                                                                                                                                     |
| D2  | **Required for owners and admins**, optional for members/viewers; **orgs can require it for everyone**                            | Not built. No org MFA policy column.                                                                                                                                                                                                                                                                                                                                    |
| D3  | Sign in with Google with explicit linking rules                                                                                   | Shipped (web). Sessions record `auth_level='google'` (**N-4 fixed**). Calendar OAuth is a separate client. Mobile and desktop do not offer Google sign-in.                                                                                                                                                                                                              |
| D4  | **Step-up (`auth_level = mfa`) for billing, retention, integrations and role changes; session rotates on step-up**                | `sessions.auth_level TEXT NOT NULL DEFAULT 'password'` exists. The domain `Session` type and `PrismaSessionRepository` now read and write `authLevel` (**P-2 partly fixed**). `SESSION_AUTH_LEVELS` is only `'password' \| 'google'`; `toSessionAuthLevel` maps any other stored value, including a future `'mfa'`, back to `'password'`. No route checks `auth_level`. |
| D5  | TOTP secrets encrypted with `TokenCipher` (ADR-016 KMS); MFA attempts rate-limited and under ADR-006 lockout; MFA changes audited | `TokenCipher` exists, but `tokenAad` still requires `organizationId` + `integrationId` (**P-3 open**). `AuditAction` has no MFA events (**P-5 open**). Lockout is still keyed by email for password login only (`DEFAULT_LOCKOUT`: 5 → delay, 10 → 15-min lock). Logger redaction of MFA field names and of a 6-digit `code` **is in place** (**P-1 and P-4 fixed**).   |
| D6  | Extension, desktop and mobile complete MFA in the system browser                                                                  | Desktop already uses a browser handoff (ADR-012). The extension pairs from a web session (ADR-005). Mobile signs in with an in-app password (ADR-005 A3.11). `AuthService` revocation goes through `extensionRevoker`, which is wired with `combineRevokers` so desktop families are included when desktop auth is on.                                                  |
| D7  | Enterprise SSO deferred                                                                                                           | Out of scope for this plan.                                                                                                                                                                                                                                                                                                                                             |

### 1.1 Step-up route inventory (ADR-021 D4 mapped to today's API)

| ADR category | Route(s) today                                                                                                                                       | Notes                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Role changes | `PATCH /orgs/:organizationId/members/:userId`                                                                                                        | Is member removal (`DELETE …/members/:userId`) or inviting an admin a "role change"? **OQ-9**               |
| Integrations | `POST /orgs/:organizationId/integrations/connect`, `DELETE /orgs/:organizationId/integrations/:integrationId`                                        | Do calendar connect/disconnect (per user), the provider callbacks, and issue push/task sync count? **OQ-9** |
| Retention    | **Not served.** `PATCH /orgs/:organizationId/settings/consent` (`retentionDays`) is in contracts and the web client, but the API doesn't register it | **Gap G-1.** It must get step-up when it is built. Pinned by `MFA-SU-02`.                                   |
| Billing      | **None** (ADR-017 not built; CASL has only `read Billing`)                                                                                           | **Gap G-2.** It must get step-up when it is built. Pinned by `MFA-SU-02`.                                   |

Other candidates that ADR-021 doesn't list: MFA disable/reset itself, recovery-code regeneration, password change (there is no route yet; reset is token-based), email change (no route), org MFA policy change, session revoke (ADR-014 already says revoke needs "step-up re-auth if the session is older than the step-up window"), extension pairing, desktop authorize. **OQ-10.**

### 1.2 Threat model for the factors ADR-021 names

ADR-021 names three factors. This is the attack surface the cases below are written against. It is a Security/QA reading of the ADR plus the current auth module; it is not extra product scope.

**TOTP (shared secret, typically 6 digits / 30 s).** Threats: phished or stuffed password then guessed or replayed codes; secret stolen from the database or from logs/QR; enrollment without a fresh proof of the account; clock-skew windows wide enough to replay; timing oracles on compare; brute force without the ADR-006 lockout. Controls the ADR actually states: encrypt the secret with `TokenCipher`, rate-limit attempts, put them under ADR-006 lockout, audit MFA changes. Window, replay cache, CSPRNG size, and constant-time compare are **[REC]** (RFC 6238) — see OQ-2.

**Recovery codes (single-use, hashed — ADR D1).** Threats: codes reused; codes stored or logged in plaintext; regeneration that leaves old codes valid; using a stolen recovery code as a quiet bypass of a lost-device or takeover event. The ADR requires single use and hashing; notification on use, step-up to regenerate, and the hash algorithm are **[REC]** (OQ-6, OQ-10, OQ-12).

**WebAuthn passkeys (ADR D1).** Threats: origin/rpId mismatch (phishing), challenge replay, cloned authenticators (sign-count), credential used as another user, attestation or algorithm downgrade, confusion over whether a passkey is a second factor or passwordless. ADR-021 names passkeys and says nothing else about them. Origin binding, challenge TTL, UV/UP, algorithms and passwordless-or-not are **[REC]** (OQ-8).

**Cross-cutting, from the current auth architecture (not stated in the ADR, but the implementation has to meet them or MFA is bypassed):**

- An MFA-pending login must not reach org APIs (otherwise D2 is theatre).
- Google OIDC is a first factor only: a Google session is `auth_level=google` today, not `mfa`. Google's own 2-Step Verification is not proof (no trusted `amr`).
- Password reset today revokes sessions, extension/desktop families and push devices, and does not touch a factor table (there isn't one). After MFA exists, reset must **not** disable MFA (**[REC]**, MFA-REC-02).
- Account takeover (`claimForGoogle` / `claimForMailbox`, #463) already changes credentials and revokes sessions in one transaction, then follows up with realtime / extension+desktop / push / one-time-link invalidation. If an attacker pre-registered the email and enrolled a factor, the claim must also destroy those factors or the victim inherits the attacker's MFA (**[REC]**, OQ-15, MFA-OIDC-05, MFA-TO-\*).
- `toSessionAuthLevel` at `6feef782` will silently downgrade a stored `'mfa'` to `'password'` until `SESSION_AUTH_LEVELS` is extended. That is a P0 implementation footgun (MFA-MIG-03, MFA-SU-09).

## 2. Proposed interface (for the tests only)

ADR-021 sets no HTTP shape. The suite targets the names below, which all live in one `PLANNED` object at the top of `mfa.security.test.ts`. If the real API differs, change that object, not the cases.

| Purpose               | Proposed                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                | `GET /auth/mfa` → `{ enabled, factors: [{ id, type, createdAt, lastUsedAt }] }` (no secrets, no codes)                                                                        |
| TOTP enroll / confirm | `POST /auth/mfa/totp/enroll` → 201 `{ factorId, otpauthUri }`; `POST /auth/mfa/totp/confirm { factorId, totpCode }` → 200 `{ recoveryCodes }`                                 |
| Login second step     | `POST /auth/mfa/challenge { totpCode } \| { recoveryCode } \| WebAuthn assertion`                                                                                             |
| Step-up               | `POST /auth/mfa/step-up` (same body)                                                                                                                                          |
| Recovery codes        | `POST /auth/mfa/recovery-codes` (regenerate)                                                                                                                                  |
| Remove factor         | `DELETE /auth/mfa/factors/:factorId`                                                                                                                                          |
| WebAuthn              | `POST /auth/mfa/webauthn/{register,authenticate}/{options,verify}`                                                                                                            |
| Error codes           | `MFA_REQUIRED` (403), `STEP_UP_REQUIRED` (403), `INVALID_MFA_CODE` (400/401, generic)                                                                                         |
| Session read          | `GET /auth/session` exposes `session.authLevel` (and ideally `authTime` / `mfaAt`)                                                                                            |
| TOTP body field       | **`totpCode`, not `code`.** A 6-digit `code` is now redacted by the logger (**P-1 fixed**), but `totpCode` is still the clearer name and is already in `DEFAULT_REDACT_KEYS`. |

How the pending login is represented (full session vs a short-lived challenge token) is **OQ-17**. Tests assert the security property (no org API access until the challenge passes), not a particular cookie name.

## 3. Enrollment (MFA-ENR)

| ID         | Case                                        | Expected                                                                                                                                                                                                 | Pri / Layer           | Sev    | Source           | TM       |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ | ---------------- | -------- |
| MFA-ENR-01 | Secret generation                           | CSPRNG, ≥160 bits (RFC 4226 §4), base32, a fresh secret per enrollment                                                                                                                                   | P0 · unit+integ       | High   | [REC]            | TM-MFA-S |
| MFA-ENR-02 | otpauth URI / QR                            | `otpauth://totp/<issuer>:<email>?secret&issuer[&algorithm&digits&period]`. Returned once with `Cache-Control: no-store`. Built on the client or as a data-URI QR; never sent to a third-party QR service | P1 · integ+e2e        | Medium | [REC]            | TM-MFA-I |
| MFA-ENR-03 | Uniqueness                                  | Two enrollments (same or different users) never share a secret                                                                                                                                           | P0 · integ            | High   | [REC]            | TM-MFA-S |
| MFA-ENR-04 | Pending factor is inactive                  | Until confirmed, the factor isn't enforced, isn't usable for step-up, and gets no recovery codes. Pending factors expire (OQ-2)                                                                          | P1 · integ+live-pg    | Medium | [REC]            | TM-MFA-T |
| MFA-ENR-05 | Confirm with a valid code before activation | A wrong code is a generic error and stays pending. A correct code activates the factor and returns recovery codes once. Confirm attempts are rate-limited                                                | P0 · integ+live-redis | High   | [REC] + [ADR] D5 | TM-MFA-T |
| MFA-ENR-06 | Re-enroll / replace                         | With an active factor, enroll needs step-up (`STEP_UP_REQUIRED` otherwise). Replacing atomically retires the old secret, is audited, and sends a notification                                            | P1 · integ            | High   | [REC] (OQ-10)    | TM-MFA-T |
| MFA-ENR-07 | Factor ownership                            | Another user can't confirm, read or delete the factor id (404, enumeration-safe)                                                                                                                         | P0 · integ+live-pg    | High   | [SPEC] §6        | TM-I     |
| MFA-ENR-08 | Enrollment needs a fresh, verified session  | An unverified email or an idle/old session can't enroll. This defends against the N-1 pre-hijack, where the attacker would enroll their own TOTP                                                         | P0 · integ            | High   | [REC] (N-1)      | TM-MFA-S |
| MFA-ENR-09 | Owner/admin forced enrollment               | An owner/admin without MFA can only reach the enrollment flow (grace: OQ-5)                                                                                                                              | P0 · integ+e2e        | High   | [ADR] D2         | TM-MFA-S |

Re-auth at enrollment: ADR-021 does not say a password or step-up is required to start the first enrollment. **[REC]** (MFA-ENR-08): the session must be fresh and the email verified. Starting a replacement enrollment on an already-MFA account needs step-up (MFA-ENR-06, OQ-10).

## 4. TOTP verification (MFA-TOTP)

| ID          | Case                               | Expected                                                                                                                                                                             | Pri / Layer           | Sev      | Source                       | TM       |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | -------- | ---------------------------- | -------- |
| MFA-TOTP-01 | Login of an MFA user is two-step   | After the password, the session is not elevated and gets `MFA_REQUIRED` on org routes until the challenge passes. No org data or CSRF-protected writes                               | P0 · integ+e2e        | Critical | [ADR] D2                     | TM-MFA-S |
| MFA-TOTP-02 | Valid code elevates and rotates    | `auth_level` becomes `mfa`, the session id rotates, the old cookie gets 401, and CSRF is re-issued                                                                                   | P0 · integ            | High     | [ADR] D4, [SPEC] §2          | TM-S     |
| MFA-TOTP-03 | Window / clock skew                | ±1 step (30 s) accepted, ±2 rejected (OQ-2 for digits/period/algorithm/window)                                                                                                       | P1 · unit             | Medium   | [REC] RFC 6238 §5.2          | TM-MFA-T |
| MFA-TOTP-04 | Replay of a used code              | A code (time step) accepted once is refused again for the same factor, across sessions and API instances (store the last used step per factor, atomically)                           | P0 · integ+live-pg    | High     | [REC] RFC 6238 §5.2          | TM-MFA-T |
| MFA-TOTP-05 | Brute force / rate limit / lockout | Per-account and per-IP limits. Failures feed ADR-006 lockout, so a correct code during lockout fails. Lockout sends the email notice. Fail closed if Redis is down                   | P0 · integ+live-redis | Critical | [ADR] D5, [SPEC] §5, ADR-006 | TM-D     |
| MFA-TOTP-06 | Input validation                   | Exactly N ASCII digits. Arrays, numbers, null, Unicode digits and extra fields get 400 without reaching the verifier or the limiter                                                  | P1 · integ            | Medium   | [SPEC] (TypeBox)             | TM-MFA-T |
| MFA-TOTP-07 | Timing-safe compare                | `timingSafeEqual` over fixed-length buffers. Every window slot is checked without an early return. Unknown factor and wrong code take the same path                                  | P1 · unit+manual      | Medium   | [REC]                        | TM-MFA-T |
| MFA-TOTP-08 | Shared lockout budget              | Password failures and MFA failures count toward the same account lockout (or separate counters with the same limits). It's OQ-4, but either way the attacker can't get 2× the budget | P0 · integ+live-redis | High     | [ADR] D5 (OQ-4)              | TM-D     |

Live-redis notes for MFA-TOTP-05/08: drive two API processes (or two limiter instances) against the same Redis; confirm the lock is shared. When Redis is unreachable, MFA verification must fail closed (no "allow on error"). The existing login limiter/lockout still has known gaps from ADR-006 (non-atomic `INCR`+`PEXPIRE` on the lockout counter; lockout notice email historically a TODO) — MFA must not regress those, and should not invent a weaker path.

Constant-time compare (MFA-TOTP-07) is asserted in unit tests by checking `timingSafeEqual` is used on equal-length buffers; a statistical timing probe (like AU-06) is manual / P2.

## 5. Recovery codes (MFA-RC)

| ID        | Case                        | Expected                                                                                                                     | Pri / Layer           | Sev    | Source           | TM       |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ | ---------------- | -------- |
| MFA-RC-01 | Generation                  | N codes (OQ-6), CSPRNG, ≥50 bits each, unique, shown once, `no-store`                                                        | P0 · integ            | High   | [ADR] D1 + [REC] | TM-MFA-S |
| MFA-RC-02 | Single use                  | A code works once (atomic consume). A second use, even concurrent, fails                                                     | P0 · integ+live-pg    | High   | [ADR] D1         | TM-MFA-T |
| MFA-RC-03 | Hashed at rest              | Only a hash is stored (argon2id or HMAC-SHA256 with a server key, OQ-6). A DB dump reveals no code. Compare is constant-time | P0 · unit+live-pg     | High   | [ADR] D1         | TM-MFA-I |
| MFA-RC-04 | Regenerate invalidates old  | Regenerating needs step-up, replaces the whole set atomically, and makes every old code fail. Audited and notified           | P1 · integ+live-pg    | High   | [REC] (OQ-10)    | TM-MFA-T |
| MFA-RC-05 | Never re-displayed          | Status, session and error responses and logs never contain codes                                                             | P1 · integ            | Medium | [REC]            | TM-MFA-I |
| MFA-RC-06 | Use is audited and notified | `auth.mfa.recovery_code.used` plus an email (it can mean a lost device or a compromise). Remaining count shown to the user   | P1 · integ            | Medium | [ADR] D5 (audit) | TM-R     |
| MFA-RC-07 | Rate limited                | Shares the MFA attempt limits and lockout (MFA-TOTP-05)                                                                      | P0 · integ+live-redis | High   | [ADR] D5         | TM-D     |

## 6. WebAuthn passkeys (MFA-WA), ADR-021 D1

| ID        | Case                     | Expected                                                                                                                                     | Pri / Layer        | Sev      | Source | TM       |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | ------ | -------- |
| MFA-WA-01 | Origin / rpId            | `clientDataJSON.origin` must be in `WEB_ORIGINS`, `type` must match the ceremony, and `rpIdHash` must equal SHA-256(rpId) (rpId: OQ-8)       | P0 · integ+manual  | Critical | [REC]  | TM-MFA-S |
| MFA-WA-02 | Challenge                | Server-generated, ≥16 bytes, single-use, short TTL, bound to the user/session. A replayed assertion fails                                    | P0 · integ         | High     | [REC]  | TM-MFA-T |
| MFA-WA-03 | Sign count               | A non-zero counter that doesn't increase fails and is audited as a possible clone. Zero counters (synced passkeys) are allowed               | P1 · integ         | Medium   | [REC]  | TM-MFA-T |
| MFA-WA-04 | User verification        | The UV flag is enforced per policy (OQ-8: required vs preferred). UP is always required                                                      | P1 · integ         | Medium   | [REC]  | TM-MFA-S |
| MFA-WA-05 | Credential ownership     | A credential id is unique and bound to its user. User A's credential can't authenticate user B. `allowCredentials` doesn't leak other users' | P0 · integ+live-pg | High     | [REC]  | TM-I     |
| MFA-WA-06 | Attestation / algorithms | Accepted COSE algs are limited (ES256, RS256). Attestation policy per OQ-8. The public key is stored, never a private key                    | P2 · unit+integ    | Low      | [REC]  | TM-MFA-I |
| MFA-WA-07 | Passkey as first factor? | Whether a passkey replaces the password (passwordless) or is only a second factor is **OQ-8**. Tests follow the decision                     | P2 · integ         | Medium   | OQ-8   | TM-MFA-S |

WebAuthn with a real platform authenticator and a security key is a **manual P1** release check (see §13). Virtual authenticators in Playwright can cover the happy path (MFA-E2E-08) but do not replace MFA-WA-01 on real hardware.

## 7. Step-up (MFA-SU), ADR-021 D4

| ID        | Case                               | Expected                                                                                                                                                                                                                                                                                                 | Pri / Layer       | Sev      | Source                | TM       |
| --------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- | --------------------- | -------- |
| MFA-SU-01 | Sensitive routes exist (inventory) | Each route in §1.1 is registered. **Active today.**                                                                                                                                                                                                                                                      | P2 · integ        | Info     | [ADR] D4              | TM-E     |
| MFA-SU-02 | Unbuilt sensitive routes (pin)     | Retention PATCH and billing are not served. When either lands, the test fails until it is added to the step-up list. **Active today.**                                                                                                                                                                   | P1 · integ        | Medium   | [ADR] D4 (G-1, G-2)   | TM-E     |
| MFA-SU-03 | Enforcement                        | On a `password`-level session, every step-up route gets 403 `STEP_UP_REQUIRED`, with no side effect and no partial write. Checked server-side (not UI only) and before the CASL/business logic mutates anything                                                                                          | P0 · integ+e2e    | Critical | [ADR] D4              | TM-MFA-S |
| MFA-SU-04 | Elevation rotates                  | Step-up issues a new session id with `auth_level=mfa`. The old id gets 401, CSRF is re-issued, and realtime gets the old session's revocation                                                                                                                                                            | P0 · integ        | High     | [ADR] D4, [SPEC] §2   | TM-S     |
| MFA-SU-05 | Google sessions                    | A Google-only session is not `mfa` and can't pass step-up without an MFA factor                                                                                                                                                                                                                          | P0 · integ        | High     | [ADR] D3/D4 (N-4)     | TM-MFA-S |
| MFA-SU-06 | Freshness / max age                | Elevation expires after the step-up window, so sensitive routes ask again. The value is **OQ-1** (ADR-014 refers to "the step-up window" without a value)                                                                                                                                                | P1 · integ        | Medium   | [SPEC] ADR-014 (OQ-1) | TM-MFA-S |
| MFA-SU-07 | Downgrade on sensitive change      | Org switch, own role change, password reset, factor removal and MFA reset drop to `password` (rotation already issues a new session; the new one must not inherit `mfa`)                                                                                                                                 | P1 · integ        | High     | [REC] (OQ-10)         | TM-MFA-T |
| MFA-SU-08 | Bearer clients                     | Extension, desktop and mobile bearer tokens can't call step-up routes without proof of MFA. They get `STEP_UP_REQUIRED`, not a bypass                                                                                                                                                                    | P0 · integ        | High     | [ADR] D6              | TM-MFA-S |
| MFA-SU-09 | Unknown auth_level values          | Any value other than the exact `mfa` string counts as not elevated (fail closed). An enum/CHECK constraint is recommended. **At `6feef782`, `toSessionAuthLevel` already maps unknowns to `password`, but it will also map a stored `mfa` to `password` until `mfa` is added to `SESSION_AUTH_LEVELS`.** | P0 · unit+live-pg | Medium   | [REC]                 | TM-MFA-T |

## 8. Sessions and disable/reset (MFA-SES, MFA-DIS)

| ID         | Case                                       | Expected                                                                                                                                                                                                                                                                                                                       | Pri / Layer | Sev      | Source           | TM       |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------- | ---------------- | -------- |
| MFA-SES-01 | `auth_level` column and default            | `sessions.auth_level TEXT NOT NULL DEFAULT 'password'`. **Active today.**                                                                                                                                                                                                                                                      | P2 · unit   | Info     | [SPEC] §2        | TM-S     |
| MFA-SES-02 | Nothing elevates today                     | The Prisma session repo can write `authLevel`, but no API path writes `mfa`. A session without a level is stored as `password`. An unknown stored level reads back as `password` (including, today, a raw `mfa` string — see MFA-MIG-03). **Active today, assertion needs a wording update when `mfa` is added to the union.** | P2 · integ  | Info     | [ADR] D4         | TM-S     |
| MFA-SES-03 | Password login not elevated                | **Active today.**                                                                                                                                                                                                                                                                                                              | P0 · integ  | High     | [ADR] D4         | TM-S     |
| MFA-SES-04 | Elevation keeps the absolute expiry        | The rotated session keeps the original absolute expiry; step-up doesn't extend a session's lifetime (OQ-7)                                                                                                                                                                                                                     | P1 · integ  | Medium   | [REC] (OQ-7)     | TM-S     |
| MFA-SES-05 | Reset / disable revokes everything else    | MFA disable or reset revokes all other sessions, extension and desktop token families, and push devices, and publishes the realtime revocation (as `resetPassword` does today via `combineRevokers`)                                                                                                                           | P0 · integ  | High     | [REC], [SPEC] §2 | TM-S     |
| MFA-SES-06 | Refresh-token families                     | Extension and desktop families issued from a `password`-level session never become `mfa` on refresh. A family records the auth level it was issued at                                                                                                                                                                          | P0 · integ  | High     | [ADR] D6 (OQ-11) | TM-MFA-T |
| MFA-SES-07 | Realtime                                   | Sockets on revoked sessions disconnect via ADR-011 fan-out (XT-41)                                                                                                                                                                                                                                                             | P1 · integ  | Medium   | [SPEC] ADR-011   | TM-S     |
| MFA-DIS-01 | Disable needs step-up                      | `DELETE /auth/mfa/factors/:id` on a `password` session gets `STEP_UP_REQUIRED`                                                                                                                                                                                                                                                 | P0 · integ  | Critical | [REC] (OQ-10)    | TM-MFA-T |
| MFA-DIS-02 | Required roles can't drop below one factor | Owners/admins (and members of an enforcing org) can't remove their last factor (409) unless the policy changes                                                                                                                                                                                                                 | P0 · integ  | High     | [ADR] D2         | TM-MFA-T |
| MFA-DIS-03 | Notification                               | Enable, disable, replace, recovery-code use and regeneration, and admin reset each send an email to the account address (not to an address the request can change)                                                                                                                                                             | P1 · integ  | High     | [REC] (OQ-12)    | TM-R     |

## 9. Google OIDC, takeover/claims, other clients, audit, tenancy, recovery, storage, CSRF, errors

### 9.1 Google OIDC (MFA-OIDC)

| ID          | Case                                     | Expected                                                                                                                                                                                 | Pri / Layer        | Sev      | Source          | TM       |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | --------------- | -------- |
| MFA-OIDC-01 | Google session not elevated              | **Active today.** Google sign-in writes `auth_level='google'`, which is not `mfa`                                                                                                        | P0 · integ         | High     | [ADR] D3/D4     | TM-MFA-S |
| MFA-OIDC-02 | Distinct auth_level for Google (**N-4**) | Google sessions record `google` (value: OQ-3). It must not be indistinguishable from `password`. **Active** (N-4 is fixed at `6feef782`)                                                 | P1 · integ         | Low      | N-4             | TM-R     |
| MFA-OIDC-03 | Owners/admins via Google still do MFA    | Google sign-in of an MFA-required user leads to the challenge. Google's own 2-Step Verification is not proof (no trusted `amr`)                                                          | P0 · integ+e2e     | Critical | [ADR] D2        | TM-MFA-S |
| MFA-OIDC-04 | `amr`/`acr` not trusted                  | Claims in the ID token never set `auth_level=mfa` unless the owner decides otherwise (OQ-3)                                                                                              | P0 · integ         | High     | OQ-3            | TM-MFA-S |
| MFA-OIDC-05 | Pre-hijack (**N-1**) x MFA               | If an attacker pre-registered the email and enrolled a factor, the victim proving the email via Google must clear the attacker's factors, sessions and password (or the link is refused) | P0 · integ+live-pg | High     | N-1, M-2, OQ-15 | TM-MFA-S |
| MFA-OIDC-06 | Linking is sensitive                     | Linking Google to an existing account with MFA needs that account's MFA (no link on email alone, M-2)                                                                                    | P0 · integ         | High     | M-2             | TM-MFA-S |

### 9.2 Account takeover and claims (MFA-TO)

This area is new in this refresh. It is not specified in ADR-021. It is a **[REC]** reading of the current `#463` claim architecture (`claimForGoogle`, `claimForMailbox`, `afterCredentialTakeover`) plus N-1 / M-2. Owner confirmation is **OQ-15**.

Today, a takeover of an unverified local account (mailbox owner verifies, or Google proves the address) changes credentials and revokes every session in one transaction, then follows up with realtime fan-out, extension and desktop family revocation (`combineRevokers`), push-device revocation, and invalidation of outstanding reset and verification links. There is no factor table yet, so nothing clears MFA. Once factors exist, leaving an attacker-enrolled TOTP in place after the victim proves the email is an account takeover.

Password reset of an already-verified account is **not** a takeover in this sense: it already revokes sessions and must **keep** MFA (MFA-REC-02).

| ID        | Case                                                | Expected                                                                                                                                                                                                                                                         | Pri / Layer        | Sev      | Source             | TM       |
| --------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | ------------------ | -------- |
| MFA-TO-01 | Mailbox claim clears attacker factors               | `claimForMailbox` (email verification or the unverified-account branch of reset) deletes every MFA factor, pending enrollment and recovery-code hash for that user in the same transaction as the claim. The victim is not left enrolled in the attacker's TOTP. | P0 · integ+live-pg | Critical | [REC] (N-1, OQ-15) | TM-MFA-S |
| MFA-TO-02 | Google claim clears attacker factors                | Same property for `claimForGoogle`. Cross-checks MFA-OIDC-05.                                                                                                                                                                                                    | P0 · integ+live-pg | Critical | [REC] (N-1, OQ-15) | TM-MFA-S |
| MFA-TO-03 | Factor deletion is in the claim, not only follow-up | A crash or follow-up failure after the claim commits must not leave factors behind. Follow-ups today are best-effort and retried in-process at `6feef782`; factor removal has to be transactional with the claim.                                                | P0 · live-pg       | High     | [REC] (OQ-15)      | TM-MFA-T |
| MFA-TO-04 | Verified-account password reset keeps MFA           | A password reset that does not take over an unverified account leaves factors in place (same expected result as MFA-REC-02). Sessions and token families are still revoked.                                                                                      | P0 · integ+e2e     | Critical | [REC]              | TM-MFA-T |

### 9.3 Extension, desktop and mobile (MFA-CLI), ADR-021 D6

| ID         | Case                        | Expected                                                                                                                  | Pri / Layer | Sev  | Source           | TM       |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- | ---- | ---------------- | -------- |
| MFA-CLI-01 | Desktop (ADR-012)           | Authorize completes only after the browser session has passed MFA for an MFA-required user                                | P0 · integ  | High | [ADR] D6         | TM-MFA-S |
| MFA-CLI-02 | Extension pairing (ADR-005) | Pairing from a `password`-level web session of an MFA-required user is refused                                            | P0 · integ  | High | [ADR] D6         | TM-MFA-S |
| MFA-CLI-03 | Mobile                      | In-app password login of an MFA-required user is refused or sent to the system browser. The mechanism for mobile is OQ-11 | P0 · integ  | High | [ADR] D6 (OQ-11) | TM-MFA-S |

### 9.4 Audit (MFA-AUD), ADR-021 D5

| ID         | Case                | Expected                                                                                                                                                                                                                                             | Pri / Layer  | Sev    | Source              | TM       |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ | ------------------- | -------- |
| MFA-AUD-01 | Events              | `auth.mfa.enroll`, `.confirm`, `.disable`, `.challenge.success`/`.failure`, `.step_up`, `.recovery_code.used`, `.recovery_codes.regenerate`, `.lockout`, `.reset` (admin), `.policy_change` (names proposed). `AuditAction` has none today (**P-5**) | P1 · integ   | Medium | [ADR] D5, [SPEC] §7 | TM-R     |
| MFA-AUD-02 | No secrets in audit | Metadata never has secrets, codes, otpauth URIs or WebAuthn private material; factor ids and types only                                                                                                                                              | P0 · integ   | High   | [SPEC] audit.ts     | TM-MFA-I |
| MFA-AUD-03 | Tenancy of events   | User-level MFA events are pre-tenant (`organizationId: null`) like login. Policy changes and admin resets carry the org id and respect RLS (OQ-13)                                                                                                   | P2 · live-pg | Low    | OQ-13               | TM-I     |

### 9.5 Multi-tenant (MFA-TEN), ADR-021 D2

| ID         | Case                             | Expected                                                                                                                                                             | Pri / Layer        | Sev      | Source           | TM       |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- | ---------------- | -------- |
| MFA-TEN-01 | Owner/admin without MFA          | Blocked from org data (only enrollment), with a grace period per OQ-5                                                                                                | P0 · integ+e2e     | Critical | [ADR] D2         | TM-MFA-S |
| MFA-TEN-02 | Org "require for everyone"       | Applies to that org's members/viewers only. A user in orgs A (enforcing) and B (not) is gated only when A is active                                                  | P0 · integ+live-pg | High     | [ADR] D2         | TM-I     |
| MFA-TEN-03 | Org switch into an enforcing org | Switching from a `password` session is refused or needs MFA first (no free pass via `/orgs/switch` or desktop switch-org)                                            | P0 · integ         | High     | [ADR] D2         | TM-MFA-S |
| MFA-TEN-04 | Policy change                    | Only owner/admin, with step-up, audited. Org B admins can't read org A members' factors (404). If a factors/policy table carries `org_id`, it has forced RLS (XT-29) | P0 · live-pg       | High     | [ADR] D2, [SPEC] | TM-I     |
| MFA-TEN-05 | Promotion to admin               | Promoting someone without MFA follows OQ-5: they enroll at next request, or the promotion is refused                                                                 | P1 · integ         | Medium   | [ADR] D2 (OQ-5)  | TM-E     |

### 9.6 Account recovery and support abuse (MFA-REC)

| ID         | Case                                  | Expected                                                                                                                                  | Pri / Layer    | Sev      | Source | TM       |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------- | ------ | -------- |
| MFA-REC-01 | All factors lost                      | Only the documented recovery path (OQ-12). Email alone never removes MFA                                                                  | P0 · integ     | Critical | OQ-12  | TM-MFA-T |
| MFA-REC-02 | Password reset keeps MFA              | Resetting the password (email token) revokes sessions as today but does **not** disable MFA. The next login still needs the challenge     | P0 · integ+e2e | Critical | [REC]  | TM-MFA-T |
| MFA-REC-03 | Admin/support reset of another member | Allowed only if OQ-12 says so. Needs the admin's step-up, is audited with the actor, emails the member, and revokes the member's sessions | P1 · integ     | High     | OQ-12  | TM-E     |
| MFA-REC-04 | Social engineering                    | Support runbook: identity checks, cooling-off delay, notify the old address (OQ-12). Manual/tabletop, not automated                       | P2 · manual    | High     | OQ-12  | TM-MFA-T |

### 9.7 Secret storage and logging (MFA-SEC)

| ID         | Case                                                       | Expected                                                                                                                                                                                                       | Pri / Layer       | Sev    | Source        | TM       |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------- | -------- |
| MFA-SEC-01 | TOTP secret encrypted at rest                              | `TokenCipher` envelope (ADR-016 KMS), AAD bound to user and factor so a blob copied to another row fails. `tokenAad` takes only org + integration today (**P-3 still open**)                                   | P0 · unit+live-pg | High   | [ADR] D5      | TM-MFA-I |
| MFA-SEC-02 | Recovery codes hashed                                      | See MFA-RC-03                                                                                                                                                                                                  | P0 · live-pg      | High   | [ADR] D1      | TM-MFA-I |
| MFA-SEC-03 | `secret` key redacted                                      | **Active today.**                                                                                                                                                                                              | P0 · unit         | High   | [SPEC] logger | TM-MFA-I |
| MFA-SEC-04 | otpauth URI in a logged URL                                | **Active today:** `secret=` is redacted                                                                                                                                                                        | P0 · unit         | High   | [SPEC] logger | TM-MFA-I |
| MFA-SEC-05 | A 6-digit `code` is redacted (**P-1 fixed** at `6feef782`) | Digit-only `code` values of 4+ digits are now redacted; only HTTP-status-sized numbers among digit-only values pass. The skipped test in `mfa.security.test.ts` should be un-skipped — it is expected to pass. | P0 · unit         | Medium | P-1 (fixed)   | TM-MFA-I |
| MFA-SEC-06 | MFA field names redacted (**P-4 fixed** at `6feef782`)     | `totpCode`, `recoveryCode(s)`, `totpSecret`, `otpauthUri` and the WebAuthn `credential`/`assertion` bodies are in `DEFAULT_REDACT_KEYS`. Un-skip the existing test; it is expected to pass.                    | P0 · unit         | Medium | P-4 (fixed)   | TM-MFA-I |
| MFA-SEC-07 | Never in errors, metrics or traces                         | The verifier throws fixed errors without the code or secret                                                                                                                                                    | P1 · integ        | Medium | [SPEC]        | TM-MFA-I |

### 9.8 CSRF and error messages (MFA-CSRF, MFA-ERR)

| ID          | Case                                        | Expected                                                                                                                          | Pri / Layer | Sev    | Source    | TM       |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | --------- | -------- |
| MFA-CSRF-01 | Step-up routes refuse missing CSRF today    | **Active today:** 403 `CSRF_INVALID`, and the same request with a token gets past CSRF                                            | P0 · integ  | High   | [SPEC] §4 | TM-T     |
| MFA-CSRF-02 | Every MFA POST/DELETE                       | Missing or wrong token, or a bad or missing Origin, gets 403 (AU-14 to AU-17). Enrollment and challenge are never GET             | P0 · integ  | High   | [SPEC] §4 | TM-T     |
| MFA-CSRF-03 | Enrollment response                         | `Cache-Control: no-store`. The QR/secret page can't be framed (`frame-ancestors 'none'`)                                          | P2 · integ  | Medium | [REC]     | TM-MFA-I |
| MFA-ERR-01  | Enrollment state not leaked before password | Wrong password gives the same response for MFA and non-MFA users (AU-05/06). "MFA required" appears only after a correct password | P1 · integ  | Medium | [SPEC] §6 | TM-MFA-S |
| MFA-ERR-02  | Generic MFA failure                         | Wrong TOTP, wrong or used recovery code, unknown factor and expired challenge give the same error and similar timing              | P1 · integ  | Medium | [SPEC] §6 | TM-MFA-T |
| MFA-ERR-03  | Org admins see status, not detail           | Member lists show at most "MFA on/off" to admins; never factor secrets or recovery-code counts to others                          | P2 · integ  | Low    | [REC]     | TM-I     |

## 10. Migrations and backfill (MFA-MIG)

ADR-021 does not describe a schema. These cases pin the security properties the first MFA migration has to meet, and the `auth_level` footgun already in the code. Table shape and RLS are **OQ-16**. Rollout for existing owners/admins is **OQ-5**.

| ID         | Case                                      | Expected                                                                                                                                                                                                                                                                                                                      | Pri / Layer       | Sev    | Source           | TM       |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ---------------- | -------- |
| MFA-MIG-01 | Factor tables store no plaintext secrets  | Migration adds TOTP / WebAuthn / recovery-code storage. A live-pg read of a confirmed factor shows a `TokenCipher` envelope, not a base32 secret; recovery rows are hashes only; WebAuthn stores the public key only. Applied against a copy of the current schema.                                                           | P0 · live-pg      | High   | [ADR] D1/D5      | TM-MFA-I |
| MFA-MIG-02 | Org policy storage and RLS                | Whatever column or table holds "org requires MFA for everyone" (OQ-13) is org-scoped with forced RLS. A session in org B cannot read org A's policy or members' factor metadata. User-global factor tables (recommended, OQ-16) still 404 across users.                                                                       | P0 · live-pg      | High   | [ADR] D2, [SPEC] | TM-I     |
| MFA-MIG-03 | `auth_level='mfa'` is a first-class value | Before any path writes `mfa`, `SESSION_AUTH_LEVELS` and `toSessionAuthLevel` accept it. A round-trip through `PrismaSessionRepository` returns `mfa`, not `password`. Unknown values still fail closed. A CHECK/enum on `sessions.auth_level` is recommended. **At `6feef782` this would fail if someone wrote `mfa` today.** | P0 · unit+live-pg | High   | [ADR] D4, [REC]  | TM-MFA-T |
| MFA-MIG-04 | Backfill / existing owners and admins     | Existing owners/admins are not silently treated as enrolled. Rollout follows OQ-5 (recommended: force enrollment at next sign-in, no grace for new promotions). Login of a non-MFA member is unchanged.                                                                                                                       | P1 · live-pg+e2e  | High   | [ADR] D2 (OQ-5)  | TM-MFA-S |
| MFA-MIG-05 | Compatibility and rollback                | The migration is additive for users with no factors. A documented rollback (drop new tables/columns, or disable the feature flag) does not lock out users or leave half-encrypted rows.                                                                                                                                       | P2 · live-pg      | Medium | [REC]            | TM-MFA-T |

## 11. End-to-end journeys (MFA-E2E)

These are Playwright cases under `tests/e2e/` (web), plus client-specific e2e where ADR-021 D6 applies. They do not replace the integ/live cases; they prove the UI and cookie/CSRF path together.

| ID         | Case                                       | Expected                                                                                                                                                                      | Pri / Layer | Sev      | Source          | TM       |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | --------------- | -------- |
| MFA-E2E-01 | Member optional enroll, logout, TOTP login | A member enrolls TOTP, stores recovery codes, logs out, signs in with password then TOTP, and reaches org data. An MFA-pending cookie cannot open a meeting or settings page. | P0 · e2e    | Critical | [ADR] D1/D2     | TM-MFA-S |
| MFA-E2E-02 | Owner forced enrollment                    | An owner without MFA is sent to enrollment and cannot use the app until confirmed (grace per OQ-5).                                                                           | P0 · e2e    | Critical | [ADR] D2 (OQ-5) | TM-MFA-S |
| MFA-E2E-03 | Recovery code, single use                  | Login with a recovery code works once; a second attempt with the same code fails generically.                                                                                 | P1 · e2e    | High     | [ADR] D1        | TM-MFA-T |
| MFA-E2E-04 | Step-up on a role change                   | A password-level session that tries `PATCH …/members/:userId` is challenged; after step-up the change succeeds and the session id has rotated.                                | P0 · e2e    | Critical | [ADR] D4        | TM-MFA-S |
| MFA-E2E-05 | Disable MFA (optional role)                | A member in a non-enforcing org disables MFA after step-up; other browsers are signed out.                                                                                    | P1 · e2e    | High     | [REC]           | TM-S     |
| MFA-E2E-06 | Google + MFA                               | Google sign-in of an MFA-required user lands on the challenge, not in the app.                                                                                                | P0 · e2e    | Critical | [ADR] D2/D3     | TM-MFA-S |
| MFA-E2E-07 | Password reset then MFA                    | After a successful reset, the next login still asks for TOTP (or a remaining recovery code).                                                                                  | P0 · e2e    | Critical | [REC]           | TM-MFA-T |
| MFA-E2E-08 | WebAuthn happy path                        | Register and authenticate with a virtual authenticator. Complements, does not replace, the manual hardware pass.                                                              | P1 · e2e    | High     | [ADR] D1        | TM-MFA-S |

## 12. Findings raised while writing this plan (updated at `6feef782`)

These were gaps the MFA implementation has to close. Several are already fixed on the integration tip; the skipped tests for P-1 and P-4 should be turned back on.

| ID  | Severity (when MFA ships) | State at `6feef782` | Where                                                                           | Finding                                                                                                                                                                                         | Fix                                                                                                |
| --- | ------------------------- | ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P-1 | Medium                    | **Fixed**           | `packages/logger/src/redact.ts` (`CONDITIONAL_REDACT_KEYS`, `ERROR_CODE_SHAPE`) | A 6-digit `{ code: '492039' }` used to be logged in clear. Digit-only values of 4+ digits are now redacted.                                                                                     | Keep the field name `totpCode`. Un-skip MFA-SEC-05.                                                |
| P-2 | Info / High leftover      | **Partly fixed**    | `domain/session.ts`, `prisma-session.repository.ts`                             | `Session.authLevel` and the Prisma repo now map and persist the column. **Leftover:** `SESSION_AUTH_LEVELS` is `'password' \| 'google'` only; `toSessionAuthLevel('mfa')` returns `'password'`. | Add `mfa` to the union (and a CHECK) before any writer uses it. Covered by MFA-MIG-03 / MFA-SU-09. |
| P-3 | Medium                    | **Open**            | `packages/integrations/src/token-crypto.ts` (`tokenAad`)                        | AAD requires `organizationId` + `integrationId`. TOTP secrets are per user (no org), so they need their own AAD context (`['meetops.mfa.totp.v1', userId, factorId]`).                          | Add a user-scoped AAD helper. Don't reuse fake org/integration ids.                                |
| P-4 | Medium                    | **Fixed**           | `DEFAULT_REDACT_KEYS`, contracts `REDACT_KEYS`                                  | MFA field names were missing. They are present on the logger (and should stay in contracts).                                                                                                    | Un-skip MFA-SEC-06.                                                                                |
| P-5 | Low                       | **Open**            | `domain/audit.ts`                                                               | `AuditAction`/`targetType` have no MFA values.                                                                                                                                                  | Add the MFA-AUD-01 actions and a `mfa_factor` target type.                                         |
| G-1 | Medium                    | **Open**            | API vs contracts                                                                | The retention PATCH (`/orgs/:id/settings/consent`) is contracted and called by the web client, but the API doesn't serve it.                                                                    | When built, put it behind step-up (MFA-SU-02 will fail until listed).                              |
| G-2 | Info                      | **Open**            | ADR-017                                                                         | No billing routes.                                                                                                                                                                              | Same as G-1.                                                                                       |

Related open findings from the Google OIDC review: **N-1** (pre-hijack; see MFA-ENR-08, MFA-OIDC-05, MFA-TO-01/02), **N-4** (Google sessions recorded as `password` — **fixed**; see MFA-OIDC-02), and **M-2** (link without proof; see MFA-OIDC-06).

## 13. Executable suite, layers, and release gates

`apps/api/test/mfa.security.test.ts` is the unit/integ suite. At `6feef782` it still describes 12 active tests, 22 skipped tests and a block of `it.todo`s, and it still calls MFA-SEC-05/06 blocked by P-1/P-4 (they are not). When this plan's docs change is followed through in the suite:

1. Un-skip MFA-SEC-05 and MFA-SEC-06 (expected to pass now).
2. Keep the two "not built yet" pins (`no /auth/mfa` route; no API writer of `authLevel='mfa'`). When MFA lands those pins fail, which is the signal to un-skip the `TODO(ADR-021)` describes and to turn todos into tests.
3. Align `PLANNED` with the real routes, fields and error codes.
4. Add live-pg / live-redis files (for example `apps/api/test/mfa.live.test.ts`) behind the existing live-DB/Redis env, and Playwright cases under `tests/e2e/`.
5. Add cases MFA-TO-\*, MFA-MIG-\* and MFA-E2E-\* to the suite index in `test-cases.md` §5.

Cases not covered by unit/inject tests alone:

- MFA-REC-04 (support runbook): tabletop.
- MFA-WA-01..06 with a real authenticator: manual pass with a platform authenticator and a security key before production.
- MFA-TOTP-07 timing: statistical, run like AU-06 (P2 manual on top of the unit assertion).

### 13.1 Release gates

**Gate A — merge to `integration/phase-1` (MFA feature branches).**

- Every P0 **unit** and **integ** case in this plan passes, including the un-skipped SEC-05/06 tests.
- MFA-MIG-03 is already green: `SESSION_AUTH_LEVELS` includes `mfa` before any writer uses it.
- P-3 is fixed (user-scoped `TokenCipher` AAD) and MFA-SEC-01 has a unit assertion for it.
- P-5 is fixed (`AuditAction` includes the MFA events); MFA-AUD-02 passes (no secrets in audit metadata).
- The MFA migration applies cleanly on a copy of the current schema; MFA-MIG-01/02 have at least a dry-run or live-pg pass in CI or on the review box.
- No `/auth/mfa*` route is a GET that mutates; CSRF is required on every POST/DELETE (MFA-CSRF-02).
- Hooks stay on (`--no-verify` is not used).

**Gate B — enable MFA in staging.**

- Every P0 **live-pg** and **live-redis** case passes (atomic recovery-code consume and TOTP replay across two API instances; RLS on policy/factor access; lockout shared and fail-closed if Redis is down).
- Every P0 **e2e** case passes (MFA-E2E-01, 02, 04, 06, 07 at minimum).
- Owner/admin forced enrollment follows the decided OQ-5 behaviour.
- Takeover cases MFA-TO-01..03 pass on live Postgres (factors go in the claim transaction).

**Gate C — production.**

- Every P1 case in this plan passes (or has an owner-accepted exception in `risk-exceptions.md`).
- Open questions that block a P0 or P1 behaviour (OQ-1, OQ-2, OQ-3, OQ-4, OQ-5, OQ-8, OQ-11, OQ-12, OQ-15, OQ-16, OQ-17) have a written owner answer, and the tests use that answer rather than the recommended default.
- Manual WebAuthn pass (platform authenticator and a security key) is recorded.
- MFA-REC-04 runbook exists if OQ-12 allows a support/admin reset.
- Rollback (MFA-MIG-05) has been rehearsed on a staging copy.

Enterprise SSO (ADR-021 D7) is not a gate for this work.

## 14. OPEN QUESTIONS for the owner (ADR-021 is silent)

| ID    | Question                                                                                                                                                                                                    | Recommended default (Security/QA)                                                                                        | Blocks                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| OQ-1  | How long does a step-up stay valid (the "step-up window" in ADR-014)? Is it the same for every sensitive action?                                                                                            | 10 minutes since the last MFA, then ask again                                                                            | MFA-SU-06                                    |
| OQ-2  | TOTP parameters: algorithm, digits, period, accepted skew, pending-enrollment expiry                                                                                                                        | SHA-1, 6 digits, 30 s, ±1 step; pending factor expires in 10 min                                                         | MFA-TOTP-03, MFA-ENR-04                      |
| OQ-3  | `auth_level` values: just `password` and `mfa`, or also `google`/`oidc` (N-4)? Can Google `amr` (e.g. `mfa`) ever count?                                                                                    | `password` \| `google` \| `mfa`; never trust `amr`                                                                       | MFA-OIDC-02/04, MFA-SU-09, MFA-MIG-03        |
| OQ-4  | Do MFA failures share the ADR-006 login lockout counter, or have their own? What thresholds?                                                                                                                | Same account counter and thresholds (5 → delay, 10 → 15-min lock + email)                                                | MFA-TOTP-05/08                               |
| OQ-5  | Required for owners/admins: what about existing owners/admins at rollout, and on promotion? Is there a grace period?                                                                                        | Enrollment forced at next sign-in; no grace for new promotions                                                           | MFA-ENR-09, MFA-TEN-01/05, MFA-MIG-04        |
| OQ-6  | Recovery codes: how many, what format, which hash?                                                                                                                                                          | 10 codes, ≥10 base32 characters, HMAC-SHA256 with a KMS-held key, or argon2id                                            | MFA-RC-01/03                                 |
| OQ-7  | Does elevation keep the session's original absolute expiry?                                                                                                                                                 | Yes                                                                                                                      | MFA-SES-04                                   |
| OQ-8  | WebAuthn: rpId, user verification required or preferred, attestation policy, passkey as a first factor (passwordless) or second factor only?                                                                | rpId = web app registrable domain; UV required; attestation `none`; second factor first, passwordless later              | MFA-WA-01..07                                |
| OQ-9  | Exact scope of "integrations" and "role changes": member removal, inviting an admin, calendar connect, issue push / task sync, OAuth callbacks?                                                             | Include removal, admin/owner invites, integration and calendar connect/disconnect; exclude issue push                    | MFA-SU-03                                    |
| OQ-10 | Do other actions need step-up: MFA disable/replace, recovery-code regeneration, org MFA policy change, session revoke (ADR-014), extension pairing, desktop authorize, email/password change?               | Yes for all of these                                                                                                     | MFA-ENR-06, MFA-RC-04, MFA-DIS-01, MFA-SU-07 |
| OQ-11 | Mobile and bearer clients: how does MFA happen (system browser handoff like desktop?), and do token families record or carry the auth level?                                                                | Browser handoff (ADR-012 pattern); families record the issuing level and never hold `mfa` for step-up                    | MFA-CLI-03, MFA-SES-06, MFA-SU-08            |
| OQ-12 | Account recovery when all factors are lost: self-service, org-admin reset, or support only? What identity checks and delay? Is email notification required? (The ADR says "audited", not "notified".)       | Org owner/admin reset with step-up plus email to the member; support-only for owners with a 24 h delay; always notify    | MFA-REC-01..04, MFA-DIS-03                   |
| OQ-13 | Where is the org MFA policy stored, and are user-level MFA audit events org-scoped or pre-tenant?                                                                                                           | `organizations.mfa_required` (RLS); user events pre-tenant like login                                                    | MFA-TEN-02/04, MFA-AUD-03, MFA-MIG-02        |
| OQ-14 | Is a "remember this device" option allowed?                                                                                                                                                                 | No (ADR doesn't mention it)                                                                                              | —                                            |
| OQ-15 | On account takeover (`claimForGoogle` / `claimForMailbox` of an unverified pre-registered account), are attacker-enrolled MFA factors deleted, and in the same transaction as the claim?                    | Yes: delete every factor, pending enrollment and recovery hash in the claim transaction, then issue the victim's session | MFA-TO-01..03, MFA-OIDC-05                   |
| OQ-16 | Are MFA factor and recovery-code tables user-global (like `sessions`) or org-scoped with forced RLS?                                                                                                        | User-global factor tables (no `org_id`); org policy on `organizations` with forced RLS; cross-user factor reads 404      | MFA-MIG-01/02, MFA-TEN-04                    |
| OQ-17 | How is the MFA-pending login represented after a correct password or Google first factor, before the challenge? (Full `password`/`google` session, `auth_level=pending`, or a short-lived challenge token?) | A short-lived, single-purpose challenge bound to the user and the login, which cannot call org APIs                      | MFA-TOTP-01, MFA-OIDC-03                     |

Not open: the password minimum (M-1) is decided: 8 characters with composition rules. This plan doesn't change it. Enterprise SSO remains deferred (ADR-021 D7) and is out of scope.
