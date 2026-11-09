# MFA security test plan (ADR-021)

- Status: **Ready for implementation. MFA is not built yet.**
- Owner: Tester & Security (ADR-021 "tests by Tester & Security"). The implementer is All Rounder Techy (Architecture).
- Sources:
  - [ADR-021](../15-decisions/ADR-021-mfa-sso.md)
  - [`auth-session-spec.md`](./auth-session-spec.md) §2, §4, §5, §7 and §9
  - [ADR-006](../15-decisions/ADR-006-login-lockout-one-time-tokens.md) (lockout)
  - [ADR-016](../15-decisions/ADR-016-secret-manager-kms.md) / [ADR-008](../15-decisions/ADR-008-oauth-pkce-token-encryption.md) (`TokenCipher`)
  - [ADR-005](../15-decisions/ADR-005-extension-auth.md), [ADR-012](../15-decisions/ADR-012-desktop-auth.md) and [ADR-014](../15-decisions/ADR-014-geoip-session-location.md) §37 (step-up window)
  - [`threat-model.md`](./threat-model.md) §3.7
  - The Google OIDC review of integration `c60fadcf` (findings N-1 to N-6, M-2)
- Executable suite: `apps/api/test/mfa.security.test.ts`. Cases are indexed in [`test-cases.md`](./test-cases.md) §5.

## 0. How to read this plan

Every requirement below is tagged with where it comes from. Only **[ADR]** items are decided.

| Tag        | Meaning                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **[ADR]**  | Stated in ADR-021.                                                                                                                  |
| **[SPEC]** | Stated in an existing spec or ADR (`auth-session-spec.md`, ADR-005/006/011/012/014/016). It applies to MFA as written.              |
| **[REC]**  | Recommended by Security/QA (industry practice: RFC 6238, WebAuthn L2, OWASP ASVS V2/V3). Not decided. Owner to confirm.             |
| **OQ-n**   | ADR-021 does not say. This is an open question for the owner (§12). Cases that depend on it use the recommended default and say so. |

Severity is the impact **if the control is missing or broken**: Critical (account takeover or MFA bypass at scale), High (bypass for one account, or loss of a sensitive secret), Medium (weakened control, needs another bug to exploit), Low (defence in depth, hygiene).

Threat-model links refer to rows in [`threat-model.md`](./threat-model.md) §3.7:

| Label    | Row                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------- |
| TM-S     | S: credential stuffing, session theft                                                              |
| TM-T     | T: CSRF on state-changing calls                                                                    |
| TM-I     | I: IDOR / cross-tenant reads                                                                       |
| TM-D     | D: API abuse (rate limits)                                                                         |
| TM-E     | E: role escalation                                                                                 |
| TM-R     | R: missing audit                                                                                   |
| TM-MFA-S | S: phished password or stolen session used for owner/admin or sensitive actions (new row, this PR) |
| TM-MFA-T | T/E: MFA bypass by replay, downgrade, or disable/reset/recovery abuse (new row, this PR)           |
| TM-MFA-I | I: TOTP secret or recovery codes leaked from the DB or logs (new row, this PR)                     |

## 1. What ADR-021 decides (and what exists today)

| #   | ADR-021 decision                                                                                                                  | State in code at `integration/phase-1` + #453                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | In-house MFA: **TOTP**, **WebAuthn passkeys**, **single-use hashed recovery codes**                                               | Not built. No `/auth/mfa*` route, no factor tables.                                                                                                                                                 |
| D2  | **Required for owners and admins**, optional for members/viewers; **orgs can require it for everyone**                            | Not built. No org MFA policy column.                                                                                                                                                                |
| D3  | Sign in with Google with explicit linking rules                                                                                   | Shipped (web). Sessions get the DB default `auth_level='password'` (**N-4**).                                                                                                                       |
| D4  | **Step-up (`auth_level = mfa`) for billing, retention, integrations and role changes; session rotates on step-up**                | `sessions.auth_level TEXT NOT NULL DEFAULT 'password'` exists (`schema.prisma:368`). The domain `Session` type and `PrismaSessionRepository` do not read or write it (**P-2**). No route checks it. |
| D5  | TOTP secrets encrypted with `TokenCipher` (ADR-016 KMS); MFA attempts rate-limited and under ADR-006 lockout; MFA changes audited | `TokenCipher` exists, but its AAD requires `organizationId` + `integrationId` (**P-3**). `AuditAction` has no MFA events (**P-5**). The lockout is keyed by email for password login only.          |
| D6  | Extension, desktop and mobile complete MFA in the system browser                                                                  | Desktop already uses a browser handoff (ADR-012). The extension pairs from a web session (ADR-005). Mobile signs in with an in-app password (ADR-005 A3.11).                                        |
| D7  | Enterprise SSO deferred                                                                                                           | Out of scope for this plan.                                                                                                                                                                         |

### 1.1 Step-up route inventory (ADR-021 D4 mapped to today's API)

| ADR category | Route(s) today                                                                                                                                       | Notes                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Role changes | `PATCH /orgs/:organizationId/members/:userId`                                                                                                        | Is member removal (`DELETE …/members/:userId`) or inviting an admin a "role change"? **OQ-9**               |
| Integrations | `POST /orgs/:organizationId/integrations/connect`, `DELETE /orgs/:organizationId/integrations/:integrationId`                                        | Do calendar connect/disconnect (per user), the provider callbacks, and issue push/task sync count? **OQ-9** |
| Retention    | **Not served.** `PATCH /orgs/:organizationId/settings/consent` (`retentionDays`) is in contracts and the web client, but the API doesn't register it | **Gap G-1.** It must get step-up when it is built. Pinned by `MFA-SU-02`.                                   |
| Billing      | **None** (ADR-017 not built; CASL has only `read Billing`)                                                                                           | **Gap G-2.** It must get step-up when it is built. Pinned by `MFA-SU-02`.                                   |

Other candidates that ADR-021 doesn't list: MFA disable/reset itself, recovery-code regeneration, password change (there is no route yet; reset is token-based), email change (no route), org MFA policy change, session revoke (ADR-014 already says revoke needs "step-up re-auth if the session is older than the step-up window"), extension pairing, desktop authorize. **OQ-10.**

## 2. Proposed interface (for the tests only)

ADR-021 sets no HTTP shape. The suite targets the names below, which all live in one `PLANNED` object at the top of `mfa.security.test.ts`. If the real API differs, change that object, not the cases.

| Purpose               | Proposed                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                | `GET /auth/mfa` → `{ enabled, factors: [{ id, type, createdAt, lastUsedAt }] }` (no secrets, no codes)                                        |
| TOTP enroll / confirm | `POST /auth/mfa/totp/enroll` → 201 `{ factorId, otpauthUri }`; `POST /auth/mfa/totp/confirm { factorId, totpCode }` → 200 `{ recoveryCodes }` |
| Login second step     | `POST /auth/mfa/challenge { totpCode } \| { recoveryCode } \| WebAuthn assertion`                                                             |
| Step-up               | `POST /auth/mfa/step-up` (same body)                                                                                                          |
| Recovery codes        | `POST /auth/mfa/recovery-codes` (regenerate)                                                                                                  |
| Remove factor         | `DELETE /auth/mfa/factors/:factorId`                                                                                                          |
| WebAuthn              | `POST /auth/mfa/webauthn/{register,authenticate}/{options,verify}`                                                                            |
| Error codes           | `MFA_REQUIRED` (403), `STEP_UP_REQUIRED` (403), `INVALID_MFA_CODE` (400/401, generic)                                                         |
| Session read          | `GET /auth/session` exposes `session.authLevel` (and ideally `authTime` / `mfaAt`)                                                            |
| TOTP body field       | **`totpCode`, not `code`.** A 6-digit `code` is **not redacted** by the logger today (**P-1**).                                               |

## 3. Enrollment (MFA-ENR)

| ID         | Case                                        | Expected                                                                                                                                                                                                 | Sev    | Source           | TM       |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | -------- |
| MFA-ENR-01 | Secret generation                           | CSPRNG, ≥160 bits (RFC 4226 §4), base32, a fresh secret per enrollment                                                                                                                                   | High   | [REC]            | TM-MFA-S |
| MFA-ENR-02 | otpauth URI / QR                            | `otpauth://totp/<issuer>:<email>?secret&issuer[&algorithm&digits&period]`. Returned once with `Cache-Control: no-store`. Built on the client or as a data-URI QR; never sent to a third-party QR service | Medium | [REC]            | TM-MFA-I |
| MFA-ENR-03 | Uniqueness                                  | Two enrollments (same or different users) never share a secret                                                                                                                                           | High   | [REC]            | TM-MFA-S |
| MFA-ENR-04 | Pending factor is inactive                  | Until confirmed, the factor isn't enforced, isn't usable for step-up, and gets no recovery codes. Pending factors expire (OQ-2)                                                                          | Medium | [REC]            | TM-MFA-T |
| MFA-ENR-05 | Confirm with a valid code before activation | A wrong code is a generic error and stays pending. A correct code activates the factor and returns recovery codes once. Confirm attempts are rate-limited                                                | High   | [REC] + [ADR] D5 | TM-MFA-T |
| MFA-ENR-06 | Re-enroll / replace                         | With an active factor, enroll needs step-up (`STEP_UP_REQUIRED` otherwise). Replacing atomically retires the old secret, is audited, and sends a notification                                            | High   | [REC] (OQ-10)    | TM-MFA-T |
| MFA-ENR-07 | Factor ownership                            | Another user can't confirm, read or delete the factor id (404, enumeration-safe)                                                                                                                         | High   | [SPEC] §6        | TM-I     |
| MFA-ENR-08 | Enrollment needs a fresh, verified session  | An unverified email or an idle/old session can't enroll. This defends against the N-1 pre-hijack, where the attacker would enroll their own TOTP                                                         | High   | [REC] (N-1)      | TM-MFA-S |
| MFA-ENR-09 | Owner/admin forced enrollment               | An owner/admin without MFA can only reach the enrollment flow (grace: OQ-5)                                                                                                                              | High   | [ADR] D2         | TM-MFA-S |

## 4. TOTP verification (MFA-TOTP)

| ID          | Case                               | Expected                                                                                                                                                                              | Sev      | Source                       | TM       |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- | -------- |
| MFA-TOTP-01 | Login of an MFA user is two-step   | After the password, the session is not elevated and gets `MFA_REQUIRED` on org routes until the challenge passes. No org data or CSRF-protected writes                                | Critical | [ADR] D2                     | TM-MFA-S |
| MFA-TOTP-02 | Valid code elevates and rotates    | `auth_level` becomes `mfa`, the session id rotates, the old cookie gets 401, and CSRF is re-issued                                                                                    | High     | [ADR] D4, [SPEC] §2          | TM-S     |
| MFA-TOTP-03 | Window / clock skew                | ±1 step (30 s) accepted, ±2 rejected (OQ-2 for digits/period/algorithm/window)                                                                                                        | Medium   | [REC] RFC 6238 §5.2          | TM-MFA-T |
| MFA-TOTP-04 | Replay of a used code              | A code (time step) accepted once is refused again for the same factor, across sessions and API instances (store the last used step per factor, atomically)                            | High     | [REC] RFC 6238 §5.2          | TM-MFA-T |
| MFA-TOTP-05 | Brute force / rate limit / lockout | Per-account and per-IP limits. Failures feed ADR-006 lockout, so a correct code during lockout fails. Lockout sends the email notice. Fail closed if Redis is down (`consumeGuarded`) | Critical | [ADR] D5, [SPEC] §5, ADR-006 | TM-D     |
| MFA-TOTP-06 | Input validation                   | Exactly N ASCII digits. Arrays, numbers, null, Unicode digits and extra fields get 400 without reaching the verifier or the limiter                                                   | Medium   | [SPEC] (TypeBox)             | TM-MFA-T |
| MFA-TOTP-07 | Timing-safe compare                | `timingSafeEqual` over fixed-length buffers. Every window slot is checked without an early return. Unknown factor and wrong code take the same path                                   | Medium   | [REC]                        | TM-MFA-T |
| MFA-TOTP-08 | Shared lockout budget              | Password failures and MFA failures count toward the same account lockout (or separate counters with the same limits). It's OQ-4, but either way the attacker can't get 2× the budget  | High     | [ADR] D5 (OQ-4)              | TM-D     |

## 5. Recovery codes (MFA-RC)

| ID        | Case                        | Expected                                                                                                                     | Sev    | Source           | TM       |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | -------- |
| MFA-RC-01 | Generation                  | N codes (OQ-6), CSPRNG, ≥50 bits each, unique, shown once, `no-store`                                                        | High   | [ADR] D1 + [REC] | TM-MFA-S |
| MFA-RC-02 | Single use                  | A code works once (atomic consume). A second use, even concurrent, fails                                                     | High   | [ADR] D1         | TM-MFA-T |
| MFA-RC-03 | Hashed at rest              | Only a hash is stored (argon2id or HMAC-SHA256 with a server key, OQ-6). A DB dump reveals no code. Compare is constant-time | High   | [ADR] D1         | TM-MFA-I |
| MFA-RC-04 | Regenerate invalidates old  | Regenerating needs step-up, replaces the whole set atomically, and makes every old code fail. Audited and notified           | High   | [REC] (OQ-10)    | TM-MFA-T |
| MFA-RC-05 | Never re-displayed          | Status, session and error responses and logs never contain codes                                                             | Medium | [REC]            | TM-MFA-I |
| MFA-RC-06 | Use is audited and notified | `auth.mfa.recovery_code.used` plus an email (it can mean a lost device or a compromise). Remaining count shown to the user   | Medium | [ADR] D5 (audit) | TM-R     |
| MFA-RC-07 | Rate limited                | Shares the MFA attempt limits and lockout (MFA-TOTP-05)                                                                      | High   | [ADR] D5         | TM-D     |

## 6. WebAuthn passkeys (MFA-WA), ADR-021 D1

| ID        | Case                     | Expected                                                                                                                                     | Sev      | Source | TM       |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------- |
| MFA-WA-01 | Origin / rpId            | `clientDataJSON.origin` must be in `WEB_ORIGINS`, `type` must match the ceremony, and `rpIdHash` must equal SHA-256(rpId) (rpId: OQ-8)       | Critical | [REC]  | TM-MFA-S |
| MFA-WA-02 | Challenge                | Server-generated, ≥16 bytes, single-use, short TTL, bound to the user/session. A replayed assertion fails                                    | High     | [REC]  | TM-MFA-T |
| MFA-WA-03 | Sign count               | A non-zero counter that doesn't increase fails and is audited as a possible clone. Zero counters (synced passkeys) are allowed               | Medium   | [REC]  | TM-MFA-T |
| MFA-WA-04 | User verification        | The UV flag is enforced per policy (OQ-8: required vs preferred). UP is always required                                                      | Medium   | [REC]  | TM-MFA-S |
| MFA-WA-05 | Credential ownership     | A credential id is unique and bound to its user. User A's credential can't authenticate user B. `allowCredentials` doesn't leak other users' | High     | [REC]  | TM-I     |
| MFA-WA-06 | Attestation / algorithms | Accepted COSE algs are limited (ES256, RS256). Attestation policy per OQ-8. The public key is stored, never a private key                    | Low      | [REC]  | TM-MFA-I |
| MFA-WA-07 | Passkey as first factor? | Whether a passkey replaces the password (passwordless) or is only a second factor is **OQ-8**. Tests follow the decision                     | Medium   | OQ-8   | TM-MFA-S |

## 7. Step-up (MFA-SU), ADR-021 D4

| ID        | Case                               | Expected                                                                                                                                                                                                        | Sev      | Source                | TM       |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | -------- |
| MFA-SU-01 | Sensitive routes exist (inventory) | Each route in §1.1 is registered. **Active today.**                                                                                                                                                             | Info     | [ADR] D4              | TM-E     |
| MFA-SU-02 | Unbuilt sensitive routes (pin)     | Retention PATCH and billing are not served. When either lands, the test fails until it is added to the step-up list. **Active today.**                                                                          | Medium   | [ADR] D4 (G-1, G-2)   | TM-E     |
| MFA-SU-03 | Enforcement                        | On a `password`-level session, every step-up route gets 403 `STEP_UP_REQUIRED`, with no side effect and no partial write. Checked server-side (not UI only) and before the CASL/business logic mutates anything | Critical | [ADR] D4              | TM-MFA-S |
| MFA-SU-04 | Elevation rotates                  | Step-up issues a new session id with `auth_level=mfa`. The old id gets 401, CSRF is re-issued, and realtime gets the old session's revocation                                                                   | High     | [ADR] D4, [SPEC] §2   | TM-S     |
| MFA-SU-05 | Google sessions                    | A Google-only session is not `mfa` and can't pass step-up without an MFA factor                                                                                                                                 | High     | [ADR] D3/D4 (N-4)     | TM-MFA-S |
| MFA-SU-06 | Freshness / max age                | Elevation expires after the step-up window, so sensitive routes ask again. The value is **OQ-1** (ADR-014 refers to "the step-up window" without a value)                                                       | Medium   | [SPEC] ADR-014 (OQ-1) | TM-MFA-S |
| MFA-SU-07 | Downgrade on sensitive change      | Org switch, own role change, password reset, factor removal and MFA reset drop to `password` (rotation already issues a new session; the new one must not inherit `mfa`)                                        | High     | [REC] (OQ-10)         | TM-MFA-T |
| MFA-SU-08 | Bearer clients                     | Extension, desktop and mobile bearer tokens can't call step-up routes without proof of MFA. They get `STEP_UP_REQUIRED`, not a bypass                                                                           | High     | [ADR] D6              | TM-MFA-S |
| MFA-SU-09 | Unknown auth_level values          | Any value other than the exact `mfa` string counts as not elevated (fail closed). An enum/CHECK constraint is recommended                                                                                       | Medium   | [REC]                 | TM-MFA-T |

## 8. Sessions and disable/reset (MFA-SES, MFA-DIS)

| ID         | Case                                       | Expected                                                                                                                                                                        | Sev      | Source           | TM       |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | -------- |
| MFA-SES-01 | `auth_level` column and default            | `sessions.auth_level TEXT NOT NULL DEFAULT 'password'`. **Active today.**                                                                                                       | Info     | [SPEC] §2        | TM-S     |
| MFA-SES-02 | Nothing elevates today                     | The Prisma session repo never writes `authLevel` `mfa` (a session without a level is stored as `password`; an unknown stored level reads back as `password`). **Active today.** | Info     | [ADR] D4         | TM-S     |
| MFA-SES-03 | Password login not elevated                | **Active today.**                                                                                                                                                               | High     | [ADR] D4         | TM-S     |
| MFA-SES-04 | Elevation keeps the absolute expiry        | The rotated session keeps the original absolute expiry; step-up doesn't extend a session's lifetime (OQ-7)                                                                      | Medium   | [REC] (OQ-7)     | TM-S     |
| MFA-SES-05 | Reset / disable revokes everything else    | MFA disable or reset revokes all other sessions, extension and desktop token families, and push devices, and publishes the realtime revocation (as `resetPassword` does today)  | High     | [REC], [SPEC] §2 | TM-S     |
| MFA-SES-06 | Refresh-token families                     | Extension and desktop families issued from a `password`-level session never become `mfa` on refresh. A family records the auth level it was issued at                           | High     | [ADR] D6 (OQ-11) | TM-MFA-T |
| MFA-SES-07 | Realtime                                   | Sockets on revoked sessions disconnect via ADR-011 fan-out (XT-41)                                                                                                              | Medium   | [SPEC] ADR-011   | TM-S     |
| MFA-DIS-01 | Disable needs step-up                      | `DELETE /auth/mfa/factors/:id` on a `password` session gets `STEP_UP_REQUIRED`                                                                                                  | Critical | [REC] (OQ-10)    | TM-MFA-T |
| MFA-DIS-02 | Required roles can't drop below one factor | Owners/admins (and members of an enforcing org) can't remove their last factor (409) unless the policy changes                                                                  | High     | [ADR] D2         | TM-MFA-T |
| MFA-DIS-03 | Notification                               | Enable, disable, replace, recovery-code use and regeneration, and admin reset each send an email to the account address (not to an address the request can change)              | High     | [REC] (OQ-12)    | TM-R     |

## 9. Google OIDC, other clients, audit, tenancy, recovery, storage, CSRF, errors

### 9.1 Google OIDC (MFA-OIDC)

| ID          | Case                                     | Expected                                                                                                                                                                                 | Sev      | Source      | TM       |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | -------- |
| MFA-OIDC-01 | Google session not elevated              | **Active today.** It is not `mfa` today, because it falls back to the `password` default                                                                                                 | High     | [ADR] D3/D4 | TM-MFA-S |
| MFA-OIDC-02 | Distinct auth_level for Google (**N-4**) | Google sessions record `google` (value: OQ-3). It must not be indistinguishable from `password`. **Active** since the N-4 fix (`google-oidc-hardening`)                                  | Low      | N-4         | TM-R     |
| MFA-OIDC-03 | Owners/admins via Google still do MFA    | Google sign-in of an MFA-required user leads to the challenge. Google's own 2-Step Verification is not proof (no trusted `amr`)                                                          | Critical | [ADR] D2    | TM-MFA-S |
| MFA-OIDC-04 | `amr`/`acr` not trusted                  | Claims in the ID token never set `auth_level=mfa` unless the owner decides otherwise (OQ-3)                                                                                              | High     | OQ-3        | TM-MFA-S |
| MFA-OIDC-05 | Pre-hijack (**N-1**) x MFA               | If an attacker pre-registered the email and enrolled a factor, the victim proving the email via Google must clear the attacker's factors, sessions and password (or the link is refused) | High     | N-1, M-2    | TM-MFA-S |
| MFA-OIDC-06 | Linking is sensitive                     | Linking Google to an existing account with MFA needs that account's MFA (no link on email alone, M-2)                                                                                    | High     | M-2         | TM-MFA-S |

### 9.2 Extension, desktop and mobile (MFA-CLI), ADR-021 D6

| ID         | Case                        | Expected                                                                                                                  | Sev  | Source           | TM       |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------- | -------- |
| MFA-CLI-01 | Desktop (ADR-012)           | Authorize completes only after the browser session has passed MFA for an MFA-required user                                | High | [ADR] D6         | TM-MFA-S |
| MFA-CLI-02 | Extension pairing (ADR-005) | Pairing from a `password`-level web session of an MFA-required user is refused                                            | High | [ADR] D6         | TM-MFA-S |
| MFA-CLI-03 | Mobile                      | In-app password login of an MFA-required user is refused or sent to the system browser. The mechanism for mobile is OQ-11 | High | [ADR] D6 (OQ-11) | TM-MFA-S |

### 9.3 Audit (MFA-AUD), ADR-021 D5

| ID         | Case                | Expected                                                                                                                                                                                                                                             | Sev    | Source              | TM       |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- | -------- |
| MFA-AUD-01 | Events              | `auth.mfa.enroll`, `.confirm`, `.disable`, `.challenge.success`/`.failure`, `.step_up`, `.recovery_code.used`, `.recovery_codes.regenerate`, `.lockout`, `.reset` (admin), `.policy_change` (names proposed). `AuditAction` has none today (**P-5**) | Medium | [ADR] D5, [SPEC] §7 | TM-R     |
| MFA-AUD-02 | No secrets in audit | Metadata never has secrets, codes, otpauth URIs or WebAuthn private material; factor ids and types only                                                                                                                                              | High   | [SPEC] audit.ts     | TM-MFA-I |
| MFA-AUD-03 | Tenancy of events   | User-level MFA events are pre-tenant (`organizationId: null`) like login. Policy changes and admin resets carry the org id and respect RLS (OQ-13)                                                                                                   | Low    | OQ-13               | TM-I     |

### 9.4 Multi-tenant (MFA-TEN), ADR-021 D2

| ID         | Case                             | Expected                                                                                                                                                             | Sev      | Source           | TM       |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | -------- |
| MFA-TEN-01 | Owner/admin without MFA          | Blocked from org data (only enrollment), with a grace period per OQ-5                                                                                                | Critical | [ADR] D2         | TM-MFA-S |
| MFA-TEN-02 | Org "require for everyone"       | Applies to that org's members/viewers only. A user in orgs A (enforcing) and B (not) is gated only when A is active                                                  | High     | [ADR] D2         | TM-I     |
| MFA-TEN-03 | Org switch into an enforcing org | Switching from a `password` session is refused or needs MFA first (no free pass via `/orgs/switch` or desktop switch-org)                                            | High     | [ADR] D2         | TM-MFA-S |
| MFA-TEN-04 | Policy change                    | Only owner/admin, with step-up, audited. Org B admins can't read org A members' factors (404). If a factors/policy table carries `org_id`, it has forced RLS (XT-29) | High     | [ADR] D2, [SPEC] | TM-I     |
| MFA-TEN-05 | Promotion to admin               | Promoting someone without MFA follows OQ-5: they enroll at next request, or the promotion is refused                                                                 | Medium   | [ADR] D2 (OQ-5)  | TM-E     |

### 9.5 Account recovery and support abuse (MFA-REC)

| ID         | Case                                  | Expected                                                                                                                                  | Sev      | Source | TM       |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------- |
| MFA-REC-01 | All factors lost                      | Only the documented recovery path (OQ-12). Email alone never removes MFA                                                                  | Critical | OQ-12  | TM-MFA-T |
| MFA-REC-02 | Password reset keeps MFA              | Resetting the password (email token) revokes sessions as today but does **not** disable MFA. The next login still needs the challenge     | Critical | [REC]  | TM-MFA-T |
| MFA-REC-03 | Admin/support reset of another member | Allowed only if OQ-12 says so. Needs the admin's step-up, is audited with the actor, emails the member, and revokes the member's sessions | High     | OQ-12  | TM-E     |
| MFA-REC-04 | Social engineering                    | Support runbook: identity checks, cooling-off delay, notify the old address (OQ-12). Manual/tabletop, not automated                       | High     | OQ-12  | TM-MFA-T |

### 9.6 Secret storage and logging (MFA-SEC)

| ID         | Case                                       | Expected                                                                                                                                                                         | Sev    | Source        | TM       |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- | -------- |
| MFA-SEC-01 | TOTP secret encrypted at rest              | `TokenCipher` envelope (ADR-016 KMS), AAD bound to user and factor so a blob copied to another row fails. `tokenAad` takes only org + integration today (**P-3**)                | High   | [ADR] D5      | TM-MFA-I |
| MFA-SEC-02 | Recovery codes hashed                      | See MFA-RC-03                                                                                                                                                                    | High   | [ADR] D1      | TM-MFA-I |
| MFA-SEC-03 | `secret` key redacted                      | **Active today.**                                                                                                                                                                | High   | [SPEC] logger | TM-MFA-I |
| MFA-SEC-04 | otpauth URI in a logged URL                | **Active today:** `secret=` is redacted                                                                                                                                          | High   | [SPEC] logger | TM-MFA-I |
| MFA-SEC-05 | A 6-digit `code` is not redacted (**P-1**) | `CONDITIONAL_REDACT_KEYS` keeps a `code` that matches `^\d{1,6}$` (it looks like an error code). Pending: name the field `totpCode` **and** add it to the always-redacted keys   | Medium | P-1           | TM-MFA-I |
| MFA-SEC-06 | MFA field names redacted (**P-4**)         | `totpCode`, `recoveryCode(s)`, `totpSecret`, `otpauthUri` (and the WebAuthn `credential`/`assertion` bodies if logged) go into `DEFAULT_REDACT_KEYS` and contracts `REDACT_KEYS` | Medium | P-4           | TM-MFA-I |
| MFA-SEC-07 | Never in errors, metrics or traces         | The verifier throws fixed errors without the code or secret                                                                                                                      | Medium | [SPEC]        | TM-MFA-I |

### 9.7 CSRF and error messages (MFA-CSRF, MFA-ERR)

| ID          | Case                                        | Expected                                                                                                                          | Sev    | Source    | TM       |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | -------- |
| MFA-CSRF-01 | Step-up routes refuse missing CSRF today    | **Active today:** 403 `CSRF_INVALID`, and the same request with a token gets past CSRF                                            | High   | [SPEC] §4 | TM-T     |
| MFA-CSRF-02 | Every MFA POST/DELETE                       | Missing or wrong token, or a bad or missing Origin, gets 403 (AU-14 to AU-17). Enrollment and challenge are never GET             | High   | [SPEC] §4 | TM-T     |
| MFA-CSRF-03 | Enrollment response                         | `Cache-Control: no-store`. The QR/secret page can't be framed (`frame-ancestors 'none'`)                                          | Medium | [REC]     | TM-MFA-I |
| MFA-ERR-01  | Enrollment state not leaked before password | Wrong password gives the same response for MFA and non-MFA users (AU-05/06). "MFA required" appears only after a correct password | Medium | [SPEC] §6 | TM-MFA-S |
| MFA-ERR-02  | Generic MFA failure                         | Wrong TOTP, wrong or used recovery code, unknown factor and expired challenge give the same error and similar timing              | Medium | [SPEC] §6 | TM-MFA-T |
| MFA-ERR-03  | Org admins see status, not detail           | Member lists show at most "MFA on/off" to admins; never factor secrets or recovery-code counts to others                          | Low    | [REC]     | TM-I     |

## 10. Findings raised while writing this plan (pre-implementation)

These are not bugs in shipped features. They are gaps that the MFA implementation has to close. P-1 and P-4 were reproduced against the current logger.

| ID  | Severity (when MFA ships) | Where                                                                           | Finding                                                                                                                                                               | Fix                                                                              |
| --- | ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P-1 | Medium                    | `packages/logger/src/redact.ts` (`CONDITIONAL_REDACT_KEYS`, `ERROR_CODE_SHAPE`) | `{ code: '492039' }` is logged in clear, because 6-digit numbers count as error codes                                                                                 | Don't name the MFA field `code`. Add the MFA keys to the always-redacted list    |
| P-2 | Info                      | `domain/session.ts`, `prisma-session.repository.ts`                             | `Session` has no `authLevel`; the repo neither maps nor writes it, so a step-up gate can't read it yet                                                                | Add `authLevel` (+ `authTime`) to the domain type, mapping and `create`/`rotate` |
| P-3 | Medium                    | `packages/integrations/src/token-crypto.ts` (`tokenAad`)                        | AAD requires `organizationId` + `integrationId`. TOTP secrets are per user (no org), so they need their own AAD context (`['meetops.mfa.totp.v1', userId, factorId]`) | Add a user-scoped AAD helper. Don't reuse fake org/integration ids               |
| P-4 | Medium                    | `DEFAULT_REDACT_KEYS`, contracts `REDACT_KEYS`                                  | No MFA field names                                                                                                                                                    | Add `totpCode`, `recoveryCode`, `recoveryCodes`, `totpSecret`, `otpauthUri`      |
| P-5 | Low                       | `domain/audit.ts`                                                               | `AuditAction`/`targetType` have no MFA values                                                                                                                         | Add the MFA-AUD-01 actions and a `mfa_factor` target type                        |
| G-1 | Medium                    | API vs contracts                                                                | The retention PATCH (`/orgs/:id/settings/consent`) is contracted and called by the web client, but the API doesn't serve it                                           | When built, put it behind step-up (MFA-SU-02 will fail until listed)             |
| G-2 | Info                      | ADR-017                                                                         | No billing routes                                                                                                                                                     | Same as G-1                                                                      |

Related open findings from the Google OIDC review: **N-1** (pre-hijack; see MFA-ENR-08, MFA-OIDC-05), **N-4** (Google sessions recorded as `password`, fixed by the OIDC hardening branch; see MFA-OIDC-02), and **M-2** (link without proof; see MFA-OIDC-06).

## 11. Executable suite and how to switch it on

`apps/api/test/mfa.security.test.ts` runs 83 tests: 12 active, 22 skipped and 49 `it.todo`. Every one of the 84 plan cases has an entry:

- **9 cases are active and pass on the current code:**
  - MFA-SES-01/02/03
  - MFA-OIDC-01
  - MFA-SU-01/02
  - MFA-CSRF-01
  - MFA-SEC-03/04

  The 12 active tests are those 9, plus two "not built yet" pins (no `/auth/mfa` route; no API code writes `authLevel`) and an RFC 6238 vector self-check of the test TOTP helper.

- **26 cases are written as concrete code in 22 skipped tests** (`describe.skip`/`it.skip`, flagged `TODO(ADR-021)`):
  - ENR-01 to ENR-07
  - TOTP-01 to TOTP-06
  - RC-01/02, RC-04, RC-05
  - SU-03/04/05
  - DIS-01/03
  - AUD-01/02
  - SEC-05 (blocked by P-1) and SEC-06 (blocked by P-4)
- **49 cases are `it.todo`.** They need the real interface, or they are manual (WebAuthn with real authenticators, clients, tenancy, recovery).

When MFA lands:

1. The two pins fail. That's the signal.
2. Align `PLANNED` with the real routes, fields and error codes.
3. Flip `describe.skip` to `describe` and turn the todos into tests.
4. Un-skip SEC-05/06 once P-1/P-4 are fixed, and OIDC-02 once N-4 is fixed.

Cases not covered by unit/inject tests:

- MFA-REC-04 (support runbook): tabletop.
- MFA-WA-01..06 with a real authenticator: manual pass with a platform authenticator and a security key before release.
- MFA-TOTP-07 timing: statistical, run like AU-06.

## 12. OPEN QUESTIONS for the owner (ADR-021 is silent)

| ID    | Question                                                                                                                                                                                              | Recommended default (Security/QA)                                                                                     | Blocks                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| OQ-1  | How long does a step-up stay valid (the "step-up window" in ADR-014)? Is it the same for every sensitive action?                                                                                      | 10 minutes since the last MFA, then ask again                                                                         | MFA-SU-06                                    |
| OQ-2  | TOTP parameters: algorithm, digits, period, accepted skew, pending-enrollment expiry                                                                                                                  | SHA-1, 6 digits, 30 s, ±1 step; pending factor expires in 10 min                                                      | MFA-TOTP-03, MFA-ENR-04                      |
| OQ-3  | `auth_level` values: just `password` and `mfa`, or also `google`/`oidc` (N-4)? Can Google `amr` (e.g. `mfa`) ever count?                                                                              | `password` \| `google` \| `mfa`; never trust `amr`                                                                    | MFA-OIDC-02/04, MFA-SU-09                    |
| OQ-4  | Do MFA failures share the ADR-006 login lockout counter, or have their own? What thresholds?                                                                                                          | Same account counter and thresholds (5 → delay, 10 → 15-min lock + email)                                             | MFA-TOTP-05/08                               |
| OQ-5  | Required for owners/admins: what about existing owners/admins at rollout, and on promotion? Is there a grace period?                                                                                  | Enrollment forced at next sign-in; no grace for new promotions                                                        | MFA-ENR-09, MFA-TEN-01/05                    |
| OQ-6  | Recovery codes: how many, what format, which hash?                                                                                                                                                    | 10 codes, ≥10 base32 characters, HMAC-SHA256 with a KMS-held key, or argon2id                                         | MFA-RC-01/03                                 |
| OQ-7  | Does elevation keep the session's original absolute expiry?                                                                                                                                           | Yes                                                                                                                   | MFA-SES-04                                   |
| OQ-8  | WebAuthn: rpId, user verification required or preferred, attestation policy, passkey as a first factor (passwordless) or second factor only?                                                          | rpId = web app registrable domain; UV required; attestation `none`; second factor first, passwordless later           | MFA-WA-01..07                                |
| OQ-9  | Exact scope of "integrations" and "role changes": member removal, inviting an admin, calendar connect, issue push / task sync, OAuth callbacks?                                                       | Include removal, admin/owner invites, integration and calendar connect/disconnect; exclude issue push                 | MFA-SU-03                                    |
| OQ-10 | Do other actions need step-up: MFA disable/replace, recovery-code regeneration, org MFA policy change, session revoke (ADR-014), extension pairing, desktop authorize, email/password change?         | Yes for all of these                                                                                                  | MFA-ENR-06, MFA-RC-04, MFA-DIS-01, MFA-SU-07 |
| OQ-11 | Mobile and bearer clients: how does MFA happen (system browser handoff like desktop?), and do token families record or carry the auth level?                                                          | Browser handoff (ADR-012 pattern); families record the issuing level and never hold `mfa` for step-up                 | MFA-CLI-03, MFA-SES-06, MFA-SU-08            |
| OQ-12 | Account recovery when all factors are lost: self-service, org-admin reset, or support only? What identity checks and delay? Is email notification required? (The ADR says "audited", not "notified".) | Org owner/admin reset with step-up plus email to the member; support-only for owners with a 24 h delay; always notify | MFA-REC-01..04, MFA-DIS-03                   |
| OQ-13 | Where is the org MFA policy stored, and are user-level MFA audit events org-scoped or pre-tenant?                                                                                                     | `organizations.mfa_required` (RLS); user events pre-tenant like login                                                 | MFA-TEN-02/04, MFA-AUD-03                    |
| OQ-14 | Is a "remember this device" option allowed?                                                                                                                                                           | No (ADR doesn't mention it)                                                                                           | —                                            |

Not open: the password minimum (M-1) is decided: 8 characters with composition rules. This plan doesn't change it.
