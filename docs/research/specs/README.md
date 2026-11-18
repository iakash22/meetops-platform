# Feature specs: top 5 proposals (November 2026)

Deep-dive specs for the five P0 proposals in PR #468 (`docs/research/feature-proposals.md`, items 1–5). Written
2026-11-11 against `integration/phase-1` at `de8a86e4`; rechecked at `809557f2` (which only adds #468's docs). File paths
are real paths on those commits.

- **Status: proposals.** Nothing here is an accepted decision. Changes to contracts need ADR-003 ownership rules; schema
  changes need a migration review; anything touching consent needs Security and the ADR-020 legal review.
- **Effort figures are estimates** in engineer-weeks (ew) per team, assuming the current agent team and no owner-blocked
  work. They are not commitments.
- Legal context: [../legal-questions-brief.md](../legal-questions-brief.md). Pricing context:
  [../pricing-packaging.md](../pricing-packaging.md).

| #   | Spec                                                                                            | Main gap (#468) | Builds on                                                                 | Effort total (estimate) |
| --- | ----------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | [Commitment-graded action items with quote and timestamp](01-commitment-graded-action-items.md) | G4              | `packages/ai-core/src/extraction/*`, `apps/worker/src/ai/action-items.ts` | ~7–9 ew                 |
| 2   | ["Since last meeting" view of live task status](02-since-last-meeting.md)                       | G5              | `calendar_event_links`, `packages/integrations/src/status-sync.ts`        | ~8–11 ew                |
| 3   | [Consent receipts with one-click revoke](03-consent-receipts.md)                                | G1              | ADR-020, `meeting_consent_events`, `apps/api/src/modules/media/*consent*` | ~10–13 ew               |
| 4   | [No-viral-growth guarantee and admin-controlled rollout](04-no-viral-growth-guarantee.md)       | G2              | ADR-013, ADR-020 item 4, `apps/api/src/modules/organizations/*`           | ~5–7 ew                 |
| 5   | [Mixed-language and Indic transcription](05-mixed-language-indic-transcription.md)              | G6              | `packages/ai-core/src/adapters/assemblyai.ts`, ADR-009                    | ~6–8 ew                 |

Suggested order: 4 (mostly policy and tests) → 5 (adapter settings) → 1 (schema v2) → 3 (needs legal input) → 2
(needs P5 sync live and calendar series data).
