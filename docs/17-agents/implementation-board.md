# Implementation board

Last updated: 2026-10-22 12:50 IST. Branch names are assigned by the Coordinator. PR numbers and states come from `git ls-remote` and `gh pr list --state all` on that date.

## Phase 0: Foundation — Done (merged)

Monorepo, apps (api/web/worker), packages, Docker Compose, CI. Branch `chore/phase-0-foundation`: PR #1 (original scaffold) and PR #2 (Phase 0 fixes) both merged to `main`.

## Phase 1: In progress

| Agent  | Workstream                       | Branch                              | PRs                                                                                                                                     | Status                        |
| ------ | -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| ARCH   | Core contracts, ADRs             | `feat/core-contracts`               | #17, #22 (ADR-004), #38 (contracts v0.2.0) merged; #50 `feat/contracts-v0.3` (v0.3.0) merged; now 0.3.2                                 | v0.3.2 on integration         |
| DB     | Schema, tenancy and RLS          | `feat/database-core-schema`         | #6 open; #25 `feat/database-tenancy-rls` open (stacked on #6); #35 `feat/database-live-verification` open                               | Open                          |
| AI     | AI provider registry             | `feat/ai-provider-registry`         | #21 open; #47 `feat/ai-transcription-summaries` open (stacked on #21)                                                                   | Open                          |
| BE     | API auth, orgs and users         | `feat/api-auth-orgs`                | #27 merged; #53 `feat/api-persistence` open                                                                                             | Auth merged; persistence open |
| FE     | Web shell                        | `feat/web-shell`                    | #13 merged; #48 `feat/web-auth-meetings` open                                                                                           | Shell merged; P1-FE-2 open    |
| OPS    | Containers, CI, tooling          | `chore/devops-containers-ci`        | #24 merged; #7, #26, #32, #33, #34, #40 open; #49 `chore/compose-hardening` open (stacked on #7)                                        | Open                          |
| QA     | QA harness                       | `test/qa-harness`                   | #9 open; #29 open (stacked on #9); #51 `test/xt-au-suites-v2` open (stacked on #29); #46 closed                                         | Open                          |
| SEC    | Threat model                     | `docs/security-threat-model`        | #4 merged                                                                                                                               | Merged into integration       |
| INT    | Notifications, integrations      | `feat/notifications-email`          | #11 open; #19 open; #36 `feat/integrations-resilience` open (stacked on #19)                                                            | Open                          |
| MEDIA  | Storage, media, realtime, worker | `feat/storage-and-media-core`       | #10 open; #16 open; #39 `feat/media-pipeline-worker` open                                                                               | Open                          |
| NATIVE | Extension                        | `feat/extension-consolidated` (#52) | #52 merged (supersedes #5, #15, #37, all closed)                                                                                        | Merged into integration       |
| DOC    | Docs                             | `docs/*`                            | #3, #8, #12, #14, #18, #23 merged; #28 open; #31 `docs/refresh-heads` open (stacked on #28); `docs/merged-phase1` open (stacked on #31) | In progress                   |

Integration: `integration/phase-1` → `main` is PR #30, merged by Akash once all Phase 1 PRs land.

Update the branch column when each agent pushes its branch.

## Later phases

- Phase 2: Meetings, uploads, FFmpeg pipeline
- Phase 3: Transcription, reports, task drafts
- Phase 4: Review/approval, notifications
- Phase 5: GitHub/Jira integrations, 2-way sync
