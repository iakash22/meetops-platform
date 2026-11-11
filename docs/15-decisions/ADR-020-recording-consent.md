# ADR-020: Recording consent by region

- Status: **Accepted — approved by owner Maddy, 2026-11-01**; amended 2026-11-11 (Amendment (2026-11-11): explicit consent on by default for every org until an org country is stored)
- Date: 2026-11-01
- Owner: Architecture (All Rounder Techy); clients by the Coordinator; tests by Tester & Security
- Related: `docs/12-security/upload-media-security.md` §7, `docs/12-security/threat-model.md` §4
- Settles: open question #8 in `docs/12-security/assumptions-open-questions.md`

## Context

Server-side consent attestation (G11) records `all_parties_notified` or `all_parties_consented` in the append-only,
RLS-forced `consent_attestations` table. Upload and recording init return 422 without an attestation (UP-16 to UP-18).
The team rule is "No covert recording: capture is always visible and consented." `upload-media-security.md` §7 also
planned a per-org "all-party vs one-party mode", and the web consent settings panel and contracts
(`CONSENT_SETTINGS_MODES`) include `one_party`.

The strictest rules apply to many calls: US all-party states (CA, FL, IL, MD, MA, MT, NH, PA, WA; CT and NV for phone
calls), Germany (§201 StGB), GDPR Art. 13 notice, and DPDP notice and consent. Participants' locations are not known, and
multi-region calls fall back to the strictest rule anyway.

## Decision

1. **All-party everywhere**: one global rule. There is **no one-party mode**.
2. The default method is notice-based (`all_parties_notified`): visible recorder name ("MeetOps Recorder"), a chat notice on
   join, and an always-visible recording indicator on every client.
3. Orgs can require explicit consent from everyone (`all_parties_consented`). This is **on by default for orgs in the EU
   or UK**.
4. Orgs can skip meetings with external participants.
5. Capture stops on `consent_revoked`.
6. `CURRENT_CONSENT_VERSION` is bumped whenever the notice text changes, so each attestation shows which notice was seen.
7. One fixed-fee legal review (India, US, EU) of the notice text and DPA happens before GA.

## Consequences

- Remove `one_party` from `CONSENT_SETTINGS_MODES` (contracts change), the web settings panel and its tests; add the
  "require explicit consent" setting. Orgs need a country to apply the EU/UK default.
- Slightly more friction where one-party consent would be legal; no per-jurisdiction rules engine to maintain.
- The threat-model residual risk "Consent law variance across jurisdictions" drops to Low once these controls ship.

## Implementation notes (consent hardening)

- **Back-dating bound.** `attestedAt` may be at most `CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS` (24 h) before the
  server receive time, as well as at most 300 s ahead. The API rejects it with 422 `CONSENT_INVALID`. Migration
  `20261031130000_consent_hardening` adds matching CHECKs on `consent_attestations.attested_at` and
  `meeting_consent_events.occurred_at` (`NOT VALID`: enforced for every new row, legacy rows aren't re-checked).
- **Ledger order.** The meeting consent ledger is ordered by the DB sequence `meeting_consent_events.seq`, never by the
  app-clock `recorded_at`, so a clock-skewed API node can't put a grant ahead of a later revocation.
- **Open: GDPR erasure (decision for Shubham).** `consent_attestations.attested_by_user_id` and
  `meeting_consent_events.actor_user_id` reference `users` with `ON DELETE RESTRICT`, and both tables are append-only.
  Deleting a user who has attested consent therefore fails. Before GA we need a GDPR Art. 17 erasure plan, for example
  pseudonymise the `users` row and keep the consent evidence (Art. 17(3)(e) legal-claims retention), or use a reviewed
  maintenance migration (`docs/16-runbooks/meeting-consent-maintenance.md`). Until then, user hard-delete is blocked
  for attesters by design.

## Amendment (2026-11-11)

- Status: **Accepted — decided by the Project Plan & Coordinator, 2026-11-11**

The original Decision item 3 said explicit consent (`all_parties_consented`) is **on by default
for orgs in the EU or UK**, and Consequences said orgs need a country to apply that default.

Orgs do not yet store a country. Until they do, **explicit consent is on by default for every
org**. That is the privacy-safe default under GDPR. Adding an org country field is a follow-up;
after it exists, the EU/UK-only default can be revisited.

Where this amendment conflicts with Decision item 3 and the matching consequence, the amendment
wins. No other part of this ADR changes (all-party everywhere, no one-party mode).
