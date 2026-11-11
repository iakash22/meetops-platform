# Spec 4: No-viral-growth guarantee and admin-controlled rollout

- Proposal #4 in PR #468 (P0). Gap G2: notetakers that spread through attendee emails and calendar access.
- Evidence: an MSP says notetakers "spread like viruses to other meeting attendees"; a sysadmin says Fireflies kept adding
  itself to meetings and emails kept coming (#468 M1, M2). Avoma's help says its assistant joins from calendar invites
  (verification-notes V9).

## 1. The guarantee (proposed public wording; needs owner and counsel review)

MeetOps will never:

1. Join a meeting on its own. Capture starts only from a person's explicit action on their own device.
2. Email, message or invite anyone outside your organisation, including meeting attendees.
3. Use attendee lists, calendars or transcripts to create accounts, waitlists or marketing contacts.
4. Let a user add MeetOps to an organisation without that organisation's admin approval (when the org turns it on).

Each line maps to an automated test that must pass on every release.

## 2. User stories

1. As an **IT admin**, I can require approval before anyone in my domain starts using MeetOps, and see who records.
2. As an **IT admin**, I can restrict recording to named teams, and block recording of meetings with external attendees
   (ADR-020 item 4).
3. As an **external attendee**, I never receive email from MeetOps (the receipt link in spec 3 is shared by the host,
   not sent by us).
4. As a **security reviewer**, I can read the guarantee and the test IDs that enforce it.

## 3. UX flow

1. Org settings → **Rollout**: "Who can record" (everyone / selected teams / nobody), "Require admin approval for new
   members from our domain", "Skip meetings with external participants" (existing ADR-020 setting).
2. A user outside the allowed set sees "Recording isn't enabled for you; ask your admin" in the extension popup, desktop
   and mobile, before any capture or consent prompt.
3. Admin sees a **Recorders** list with last recording date.
4. Public page `/trust/no-viral-growth` lists the four lines and test IDs.

## 4. Data model and API sketch

Today:

- Roles owner/admin/member/viewer and CASL abilities (`apps/api/src/modules/organizations/domain/abilities.ts`,
  `docs/12-security/rbac-matrix.md`). Members can create recording sessions; viewers can't.
- Invitations are explicit, hashed tokens (`Invitation.tokenHash`, `apps/api/src/modules/organizations/domain/invitation.ts`).
- Consent settings include `skipExternalParticipants` (`packages/contracts/src/api/consent-settings.ts`).
- Notifications resolve recipients by re-checking org membership (ADR-013), so non-members get nothing.
- No bot app exists in `apps/`; `MeetingSource` still includes `bot` (`packages/database/prisma/schema.prisma`).

Proposed:

- Org settings: `recording_policy` (`everyone | teams | none`), `recording_team_ids uuid[]`, `domain_join_requires_approval
boolean`. Contracts: extend the consent settings object or add `RolloutSettings` (ADR-003).
- Enforcement point: recording-session init and upload init check the policy after CASL (same place as the consent
  attestation check, `docs/12-security/upload-media-security.md` §7). 403 `RECORDING_NOT_ALLOWED`.
- `GET /orgs/:organizationId/settings/rollout`, `PATCH` (owner/admin), `GET /orgs/:organizationId/recorders` (owner/admin).
- Decide whether to remove `bot` from `MeetingSource` or keep it reserved; if a bot ever ships, guarantee 1 needs an
  explicit carve-out reviewed by the owner.

## 5. Tests that enforce the guarantee (QA/security)

| ID     | Asserts                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| NVG-01 | No code path creates a recording session without an authenticated user action (API + client tests) |
| NVG-02 | The email channel refuses recipients that aren't active org members (ADR-013 fan-out)              |
| NVG-03 | Calendar attendee emails are never written to `users`, `invitations` or any marketing table        |
| NVG-04 | Recording init returns 403 when `recording_policy` excludes the user                               |
| NVG-05 | With `skipExternalParticipants`, capture doesn't start when an attendee is outside the org domain  |

These would live under `tests/security` and the relevant `apps/*/test` folders.

## 6. AI approach

- None needed. Transcripts and summaries are never used to find or contact people (guarantee 3).

## 7. Risks

- **Slower growth.** We give up the viral loop competitors use. That is the point; pricing and sales must work without it.
- Domain detection for "external" is imperfect (personal emails, subsidiaries). Let admins add allowed domains.
- A guarantee is a public promise: if a test is skipped, the claim is false. Release gating must include the NVG tests.

## 8. Success metrics (targets are estimates)

- 0 emails sent to non-members (monitored by NVG-02 in production logs, counts only).
- Admin-approval adoption ≥30% among orgs with 10+ members.
- Security questionnaires: the guarantee page is cited in deals (qualitative).

## 9. Effort per team (estimates)

| Team        | Work                                                     | Estimate |
| ----------- | -------------------------------------------------------- | -------- |
| Backend     | Settings, enforcement at init, recorders list, contracts | 1.5–2 ew |
| Frontend    | Rollout settings, recorders list, trust page             | 1–1.5 ew |
| Native      | "Not enabled" states in extension, desktop and mobile    | 1 ew     |
| AI          | —                                                        | 0 ew     |
| QA/security | NVG-01..05, release gate                                 | 1.5–2 ew |
