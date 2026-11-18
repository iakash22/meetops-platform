# ADR-021: MFA and SSO

- Status: **Accepted — approved by owner Maddy, 2026-11-01**
- Date: 2026-11-01
- Owner: Architecture (All Rounder Techy); UI by the Coordinator; tests by Tester & Security
- Related: [ADR-005](./ADR-005-extension-auth.md), [ADR-006](./ADR-006-login-lockout-one-time-tokens.md), [ADR-008](./ADR-008-oauth-pkce-token-encryption.md), [ADR-012](./ADR-012-desktop-auth.md), [ADR-016](./ADR-016-secret-manager-kms.md), `docs/12-security/auth-session-spec.md`
- Settles: open question #11 in `docs/12-security/assumptions-open-questions.md`

## Context

Sign-in was email and password only. `auth-session-spec.md` §9 lists MFA (TOTP/WebAuthn) for owners and admins and SSO
(OIDC/SAML) per org as future work; sessions already rotate on "MFA step-up", and `sessions.auth_level` exists (default
`password`). Desktop sign-in (ADR-012) goes through the system browser with PKCE and reuses web login. The Google OAuth
client ("calendar + login") was waiting on the owner.

Options considered (prices checked 2026-11-01): build in-house (no licence cost); WorkOS (AuthKit free to 1M MAU, SSO
$125 per connection per month for 1–15 connections); a hybrid that buys WorkOS SSO only per enterprise deal. Ory Polis
(Apache-2.0, formerly BoxyHQ SAML Jackson) is a self-hosted SAML option.

## Decision

1. Build MFA in-house now: **TOTP and WebAuthn passkeys**, plus single-use hashed recovery codes.
2. MFA is **required for owners and admins** and optional for members and viewers. Orgs can require it for everyone.
3. Add **Sign in with Google** (OIDC) with explicit account-linking rules.
4. Step-up (`auth_level = mfa`) is required for billing, retention, integrations and role changes; the session rotates on
   step-up.
5. TOTP secrets are encrypted with `TokenCipher` (ADR-016 KMS). MFA attempts are rate-limited and covered by ADR-006
   lockout, and MFA changes are audited.
6. Extension, desktop and mobile complete MFA in the system browser (ADR-012; ADR-005 A3.11).
7. Enterprise SAML/OIDC SSO is **deferred until the first enterprise deal**. Default to self-hosted Ory Polis; use WorkOS
   if speed matters. SSO is Enterprise-plan only.

## Consequences

- MFA depends on ADR-016 (KMS) for secret encryption.
- Unblocks the P1 "MFA/SSO decision" blocker. MFA and enterprise SSO are still not built.
- Web Google sign-in shipped 2026-11-07 (authorization code + PKCE, ID token verification, linking by `sub`). The button stays off until `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` are set together. Calendar OAuth remains a separate client. Mobile and desktop do not offer Google sign-in.
- No licence cost now; SSO cost is added only alongside enterprise revenue.

## Amendment 1 (2026-11-11): open questions decided, findings P-2 / P-3 / P-5

The Coordinator approved every recommended default in `docs/12-security/mfa-test-plan.md` §14 (PR #470) on
2026-11-11. The key words MUST, MUST NOT and SHOULD are as in RFC 2119. Where this amendment conflicts with the Decision
above, the amendment wins. The MFA backend series (`feat/mfa-*` PRs into `integration/phase-1`) builds to these answers.

### A1.1 Decisions

| ID    | Decision                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1  | A step-up stays valid for **10 minutes** after the last MFA check (`sessions.mfa_at`), the same for every sensitive action; then the user is asked again.                                                               |
| OQ-2  | TOTP is RFC 6238 **SHA-1, 6 digits, 30 s**, accepting **±1 step** of skew. A pending (unconfirmed) factor expires after **10 minutes**. A code is accepted only for a step greater than the last accepted one (replay). |
| OQ-3  | `sessions.auth_level` is exactly `password` \| `google` \| `mfa` (DB CHECK). Google's `amr`/`acr` claims MUST NOT elevate a session; Google is a first factor only.                                                     |
| OQ-4  | MFA failures share the ADR-006 **login lockout counter and thresholds** for the account (5 failures → progressive delay, 10 → 15-minute lock and email). A correct code during a lock still fails.                      |
| OQ-5  | Owners and admins without MFA are forced to enroll at their next sign-in. There is no grace period for new promotions.                                                                                                  |
| OQ-6  | **10** recovery codes of at least 10 base32 characters, stored only as HMAC-SHA-256 under a key that is itself KMS-encrypted (or argon2id). Single use, shown once.                                                     |
| OQ-7  | Elevation (challenge or step-up) keeps the session's **original absolute expiry**.                                                                                                                                      |
| OQ-8  | WebAuthn: rpId = the web app's registrable domain; user verification required; attestation `none`; passkeys are a second factor first, passwordless later. (WebAuthn is not in the first MFA series.)                   |
| OQ-9  | Step-up scope "integrations" and "role changes" includes member removal, admin/owner invitations, and integration **and calendar** connect/disconnect. Issue push is excluded.                                          |
| OQ-10 | Step-up is also required for MFA disable/replace, recovery-code regeneration, org MFA policy changes, session revoke (ADR-014), extension pairing, desktop authorize, and email/password change.                        |
| OQ-11 | Mobile and bearer clients complete MFA through a system-browser handoff (ADR-012 pattern). Token families record the issuing level and never carry `mfa` for step-up.                                                   |
| OQ-12 | Lost factors: an org owner/admin may reset a member's MFA with step-up plus an email to the member; owners are reset by support only, after a 24-hour delay. The user is always notified.                               |
| OQ-13 | The org MFA policy is `organizations.mfa_required`. User-level MFA audit events are pre-tenant (`organization_id` NULL), like login.                                                                                    |
| OQ-14 | There is **no** "remember this device" option.                                                                                                                                                                          |
| OQ-15 | An account takeover claim (`claimForGoogle` / `claimForMailbox`) MUST delete every factor, pending enrollment and recovery hash of the account **in the claim transaction**, before the victim's session is issued.     |
| OQ-16 | Factor and recovery-code tables are **user-global** (no `org_id`); the org policy lives on `organizations` with forced RLS; reading another user's factor is a 404.                                                     |
| OQ-17 | After a correct first factor (password or Google), a user with MFA gets a **short-lived, single-purpose challenge** bound to the user and that login attempt. It is not a session and cannot call org APIs.             |

### A1.2 Findings closed by the implementation

- **P-2:** `SESSION_AUTH_LEVELS` includes `mfa`, so a stored `mfa` level reads back as `mfa` (unknown values still read
  back as `password`). Only the elevation path writes it; a source pin in `apps/api/test/mfa.security.test.ts` keeps the
  list of files that reference the level reviewed.
- **P-3:** `TokenCipher` gains `encryptUserSecret` / `decryptUserSecret` with the AAD
  `["meetops.mfa.totp.v1", userId, factorId]`. The envelope format (`v1.<keyId>.<wrapped>.<body>`) and the integration
  `encrypt` / `decrypt` AAD are unchanged, so every existing ciphertext still decrypts; no data migration is needed.
- **P-5:** `AuditAction` gains the MFA events (enroll, confirm, disable, challenge success/failure, step-up, recovery
  code used, recovery codes regenerated, MFA lockout). They are pre-tenant and go through
  `public.record_global_auth_event`, whose allowlist gains the matching `auth.mfa_*` actions and the `mfa_factor` target.

### A1.3 Implementation notes

- Factor tables have no `org_id` (OQ-16). They additionally carry forced RLS keyed on `app.current_user_id`
  (defence in depth; the app always sets it), so a wrong factor id finds nothing.
- `organizations` is a reviewed global table without RLS today. Adding `organizations.mfa_required` follows OQ-13;
  putting forced RLS on `organizations` itself touches every pre-context organization lookup and is tracked separately
  (writes to the column go through the org-context, CASL-checked, step-up-guarded route).
- WebAuthn (D1, OQ-8) and enterprise SSO (D7) are not part of the first MFA series.
