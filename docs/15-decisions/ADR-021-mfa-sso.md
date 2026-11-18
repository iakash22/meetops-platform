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
