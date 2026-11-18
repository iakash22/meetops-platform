# Spec 3: Consent receipts with one-click revoke (ADR-020)

- Proposal #3 in PR #468 (P0). Gap G1: people who never signed up have no record of what they were told and no way to
  object.
- Evidence: Otter's wiretap and BIPA claims survived a motion to dismiss (13 Aug 2026); Fireflies and Granola face class
  actions over non-users' data; the Granola complaint targets bot-free capture that others "won't know" about. See
  [../legal-questions-brief.md](../legal-questions-brief.md) and [../verification-notes.md](../verification-notes.md) L1–L4.
- **Needs the ADR-020 item 7 legal review** before GA. Nothing here is legal advice.

## 1. User stories

1. As an **external participant** (no MeetOps account), I get a link that shows: who recorded, when, which notice version
   I was shown, how consent was recorded, how long data is kept, and a **Revoke** button.
2. As a **participant who revokes during the meeting**, capture stops for that meeting on every client within seconds.
3. As a **participant who revokes after the meeting**, I get a confirmation and a deletion request is logged and acted on
   under the org's policy (ADR-019).
4. As an **org admin**, I see all receipts and revocations for a meeting in the consent panel and can export them.
5. As the **host**, I can show the receipt link as a QR code or paste it in the meeting chat.

## 2. UX flow

1. Host starts capture (extension, desktop or mobile). Today the host acknowledges a notice (`CONSENT_NOTICE`,
   `apps/extension/src/lib/consent.ts`; `apps/mobile/src/consent/ConsentSheet.tsx`; `apps/desktop/src/features/recording/consent.ts`).
2. **New:** the client shows a "Share notice" card with a short link and QR code, and copies a chat message ("This
   meeting is being recorded by MeetOps for <org>. Your notice and options: <link>"). Where the org uses
   `all_parties_consented` (the default for all orgs until an org country is stored, per the project lead's 2026-11-11
   decision recorded in `competitive-landscape.md` §4; ADR-020 itself says EU/UK) the link asks each person to consent.
3. A participant opens the link: a public page (no login) with the notice text for `CURRENT_CONSENT_VERSION`, the org's
   retention (ADR-019), an optional name/email field, and **Consent** / **Revoke** buttons.
4. Revoke during capture → `meeting_consent_events` gets `revoked` → realtime push to the recording client → capture stops
   ("capture stops on `consent_revoked`", ADR-020 item 5). The host sees "Stopped: a participant revoked consent".
5. Revoke after the meeting → the receipt shows "Revoked at …; deletion requested". The org's admins get an in-app task
   to review (ADR-013).
6. The meeting's consent panel (`apps/web/src/features/meetings/consent-panel.tsx`) lists receipts, consents and
   revocations by sequence.

## 3. Data model and API sketch

Today:

- `meeting_consent_events` (`packages/database/prisma/schema.prisma`, `MeetingConsentEvent`): append-only, ordered by
  `seq`, `eventType granted|revoked`, `consentVersion`, `method`, `reason`, `actorUserId` (**a signed-in user**), with the
  ADR-020 back-dating CHECKs (migration `20261031130000_consent_hardening`).
- Routes (`packages/contracts/src/api/meeting-consent.ts`, `apps/api/src/modules/media/http/meeting-consent.routes.ts`):
  `GET/POST /orgs/:organizationId/meetings/:meetingId/consent` and `POST …/consent/revoke`, for owner/admin/member with
  CSRF. External people can't call them.
- `MeetingParticipant` has `displayName`, `email`, `userId` (null for external attendees).

Proposed:

- New table `consent_receipts` (append-only, RLS-forced like `consent_attestations`):
  `id, org_id, meeting_id, token_hash (unique), consent_version, method, issued_at, expires_at, participant_id null,
display_name null, email_hash null`.
- Extend the ledger without breaking its guarantees: `meeting_consent_events.actor_user_id` becomes nullable **only** when
  a new `receipt_id` is set (CHECK: exactly one of `actor_user_id`, `receipt_id`). Ordering stays by `seq`. The GDPR
  erasure question in ADR-020 applies to receipts too: store an email **hash**, not the email.
- Public routes (no session; token in the path; rate-limited; no CSRF cookie, so a per-token nonce on POST):

```ts
// GET  /public/consent/:token          -> { orgName, meetingTitle?, recordedBy, startedAt, notice: { version, text }, retentionDays, state }
// POST /public/consent/:token/grant    -> 201 { state: 'granted' }   (only where the org requires explicit consent)
// POST /public/consent/:token/revoke   -> 201 { state: 'revoked', deletionRequestId }
// Host: POST /orgs/:organizationId/meetings/:meetingId/consent/receipts -> 201 { url, qrSvg, expiresAt }
```

- Tokens: 128-bit random, stored as a hash (as `Invitation.tokenHash` does), expire after the org's retention window.
- Realtime: a `meeting:{org}:{meeting}` event on revoke so clients stop capture (`apps/realtime`, ADR-011 auth).
- Deletion: a revoke after the meeting creates a deletion request processed by the ADR-019 purge job (audited, counts
  only). Policy question for counsel: delete the whole recording, or redact the revoker's segments?

## 4. AI approach

- None in the consent path, by design. Consent decisions are never inferred.
- Optional: translate the notice into the org's languages (spec 5) with a human-approved, versioned text per language;
  each translation bumps `CURRENT_CONSENT_VERSION`.

## 5. Risks

- **Legal fit unknown.** Whether a link-based notice is enough for botless capture, BIPA written releases, GDPR Art. 13 and
  DPDP is a counsel question (legal brief §4.1).
- **Abuse:** a leaked link lets anyone revoke and stop a recording. Accepted by design (all-party rule); mitigations:
  rate-limits, audit, host notification.
- **Token leakage** in logs or referrers. Mitigation: `Referrer-Policy: no-referrer`, tokens never logged (follows
  `docs/12-security/secrets-policy.md` practice).
- **Ledger integrity:** relaxing `actor_user_id` must not weaken the append-only and back-dating guarantees; Security
  reviews the migration.
- Participants may never open the link. Receipts don't replace the in-meeting notice.

## 6. Success metrics (targets are estimates)

- 100% of recordings have a receipt link issued (enforced at session init once shipped).
- Revoke → capture stopped on all clients in ≤5 s at p95.
- Post-meeting deletion requests completed within the policy window 100% of the time (audited).
- Counsel sign-off obtained before GA (ADR-020 item 7).

## 7. Effort per team (estimates)

| Team        | Work                                                                                                                          | Estimate   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Backend     | Receipts table, ledger change, public routes, realtime revoke, deletion request                                               | 3.5–4.5 ew |
| Frontend    | Public receipt page, host share card, consent panel updates                                                                   | 2–2.5 ew   |
| Native      | Share card + QR, and stop-on-revoke in extension, desktop and mobile                                                          | 2–3 ew     |
| AI          | Optional notice translation workflow                                                                                          | 0.5 ew     |
| QA/security | Threat model update, token tests, rate limits, ledger CHECK tests, e2e revoke (`apps/mobile/e2e/record-consent.yaml` pattern) | 2–2.5 ew   |
