# Implementation board

Last updated: 2026-10-27 ~23:20 IST, from `gh pr list --state open`, `gh pr view` and the tree at `integration/phase-1` `99a6f4f`. Phase percentages and per-phase merge lists are in [`docs/PHASE_STATUS.md`](../PHASE_STATUS.md); this board tracks PR state only.

Flow: feature branch → PR into `integration/phase-1` → merge gate (local CI, reviews) → integration → `main` PR merged by the owner. `main` is at `02646a1` (merge of #253) and contains `integration/phase-1` up to `99a6f4f`.

## Open PRs

| PR   | Branch                                 | Base                  | State | Status                                  |
| ---- | -------------------------------------- | --------------------- | ----- | --------------------------------------- |
| #192 | `docs/adr-012-desktop-amendment`       | `integration/phase-1` | Draft | ADR-012 amendment, needs owner sign-off |
| #193 | `docs/adr-005-mobile-header-token`     | `integration/phase-1` | Draft | ADR-005 amendment, needs owner sign-off |
| #199 | `docs/adr-005-extension-consent-route` | `integration/phase-1` | Draft | ADR-005 amendment, needs owner sign-off |
| #254 | `backup/desktop-native-unpushed`       | `integration/phase-1` | Draft | Backup only, do not merge               |
| #255 | `backup/mobile-securestore-unpushed`   | `integration/phase-1` | Draft | Backup only, do not merge               |

## Merged on 27 Oct 2026 (IST)

| Base                  | PRs                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `integration/phase-1` | #205–#209, #212–#246, #249 (ADR-013 notifications plan), #251 (real mail transport + Resend) |
| `main`                | #211, #247, #252, #253 (integration → `main`); #248 (status docs); #250 (ADR-013 plan)       |

## Phases

| Phase | Scope                                            | State (see `PHASE_STATUS.md`) |
| ----- | ------------------------------------------------ | ----------------------------- |
| 0     | Foundation                                       | Done                          |
| 1     | Auth, orgs, directory, RBAC                      | ~90%                          |
| 2     | Meetings, uploads, recording                     | ~75%                          |
| 3     | Transcripts, reports                             | ~65%                          |
| 4     | Tasks, approval, notifications                   | ~70%                          |
| 5     | GitHub, Jira                                     | ~65%                          |
| 6     | Extension, live transcription                    | ~70%                          |
| 7     | Calendar, search, analytics                      | 5%                            |
| 8     | Desktop (`apps/desktop`), mobile (`apps/mobile`) | ~55%                          |
| 9     | Hardening, release                               | ~25%                          |

## History

The 2026-10-21/22 Phase 1 board (PRs #3–#26, #35, #39, #50) is superseded. Every PR on it has merged or been closed; see `git log` for this file.
