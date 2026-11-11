# ADR-022: Account claim on cross-device email verify

- Status: **Accepted — decided by the Project Plan & Coordinator, 2026-11-11**
- Date: 2026-11-11
- Owner: Architecture (All Rounder Techy)
- Related: [ADR-006](./ADR-006-login-lockout-one-time-tokens.md), [ADR-021](./ADR-021-mfa-sso.md),
  `docs/04-api/auth-and-orgs.md`, PRs #459 and #463
- Settles: owner decision OD-1

## Context

Verifying an email (`POST /auth/verify-email`) proves the mailbox, not who chose the account's
password or linked Google sign-in. An attacker who knows only the victim's address can
pre-register an unverified account (Sudhodanan and Paverd, USENIX Security 2022). If the later
verify kept that password, the attacker would still be able to sign in after the owner proved the
address.

#459 and #463 already implement a mailbox-owner claim for a signed-out, cross-device verify of an
unverified account. OD-1 asked whether that behaviour should stay, or whether the verify page
should instead keep the password (for example by prompting for the current password).

Checked against `integration/phase-1` at `de8a86e4` (including the #463 takeover follow-ups, merge
`6feef782`):

- Signup sets a 24-hour HttpOnly, SameSite=Strict `meetops_sid_signup` cookie. Verifying with that
  cookie, or inside a live session of the account, marks the email verified, signs out the
  account's other sessions, and keeps the password.
- A signed-out verify from any other browser (no signup cookie, no live session of the account)
  runs `AccountClaimStore.claimForMailbox` in one transaction: mark verified, clear
  `password_hash`, clear `google_sub`, and revoke every session. Follow-up steps then revoke
  extension and desktop token families (wired through `combineRevokers`, with `propagate: true`),
  push devices and outstanding one-time links, and enqueue a set-password mail through the regular
  reset flow. A failed transaction is 503 (nothing changed). After a successful commit, the
  response is 204 with `x-meetops-verify-outcome` (`password_reset`, `set_password`, or
  `verified`).
- An already-verified account keeps its password; only other sessions are signed out.
- A password reset of an unverified account marks it verified and removes a Google link made
  before the address was proven; the new password stays.
- The `/verify-email` page asks only for confirmation. It does not prompt for the current
  password.

No mismatch was found between this decision and that code.

## Decision

Keep the current behaviour. No code change.

1. A signed-out, cross-device verify of an unverified account clears the password, unlinks Google
   sign-in that was linked before the email was proven, revokes all sessions and tokens, and emails
   a set-password link.
2. Verified accounts keep their password.
3. The verify page does not prompt for the current password.

A verify from the registering browser or from the account's own live session still keeps the
password, as already implemented.

## Consequences

- A pre-registered unverified password cannot survive mailbox proof, which closes the pre-hijack
  path in which the attacker registers first and waits for the owner to verify.
- A legitimate user who opens the verification email on a different device, while signed out and
  without the signup cookie, must set a new password from the emailed link. That is accepted.
- The verify page stays a single confirmation step, so the mailbox owner can claim the account
  without knowing a squatter's password.
- Docs (`auth-and-orgs.md`, `HANDOFF.md`, `PHASE_STATUS.md`, `AGENT_STATUS.md`) record OD-1 as
  decided in this ADR.

## Residual risk

- A legitimate user who verifies on another device (no signup cookie, not signed in there) loses
  the password they chose and has to set a new one. Accepted under this decision.
- Accounts verified **before** the #459 claim change keep whatever password they had. If one was
  pre-registered by someone else and then verified by the owner before that change, the squatter's
  password still works until the owner resets it.
- Linking Google to an already-verified account signs out its other sessions but does not remove
  the password. A password reset does not remove a Google link made after the address was proven.
- After the claim transaction commits, a follow-up that still fails (mail enqueue, token-family or
  push-device revocation) is logged and retried in-process (`auth.takeover.follow_up_failed`, then
  `auth.takeover.follow_up_abandoned`). In-process retries are lost on restart; that is unchanged
  from #463 and is not part of OD-1.

## References

- Avinash Sudhodanan and Andrew Paverd, "Pre-hijacked accounts: An Empirical Study of Security
  Failures in User Account Creation on the Web", 31st USENIX Security Symposium (USENIX Security
  22), 2022.
  <https://www.usenix.org/conference/usenixsecurity22/presentation/sudhodanan>
  (PDF: <https://www.usenix.org/system/files/sec22-sudhodanan.pdf>)
- NIST Special Publication 800-63B-4, _Digital Identity Guidelines: Authentication and
  Authenticator Management_, §4.3 Loss, Theft, Damage, and Compromise and §4.5 Invalidation.
  <https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63B-4.pdf>
  and <https://pages.nist.gov/800-63-4/sp800-63b/events/>
- OWASP Forgot Password Cheat Sheet.
  <https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html>
- OWASP Email Validation and Verification Cheat Sheet (ownership verification; also referenced
  from the Input Validation Cheat Sheet's email section).
  <https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html>
- OWASP Input Validation Cheat Sheet, Email Address Validation.
  <https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html>
