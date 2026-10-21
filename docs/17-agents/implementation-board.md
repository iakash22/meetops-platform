# Implementation board

Last updated: 2026-10-21. Branch names are assigned by the Coordinator. "Pushed?" and PR numbers come from `git ls-remote` and `gh pr list --state all` on that date.

## Phase 0: Foundation — Done (merged)

Monorepo, apps (api/web/worker), packages, Docker Compose, CI. Branch `chore/phase-0-foundation`: PR #1 (original scaffold) and PR #2 (Phase 0 fixes) both merged to `main`.

## Phase 1: In progress

| Agent  | Workstream                                                                                                                                                                  | Branch                           | Pushed? | PR                                              | Status      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- | ----------------------------------------------- | ----------- |
| ARCH | Core contracts | `feat/core-contracts` | Yes | #17 (open, contracts); #22 `docs/adr-004` (open, ADR-004) | In progress |
| DB     | Database schema and migrations                                                                                                                                              | `feat/database-core-schema`      | Yes     | #6 (open)                                       | In progress |
| AI | AI provider registry | `feat/ai-provider-registry` | Yes | #21 (open) | In progress |
| BE     | API auth and organizations                                                                                                                                                  | `feat/api-auth-orgs`             | Not yet | None                                            | In progress |
| FE     | Web shell                                                                                                                                                                   | `feat/web-shell`                 | Yes     | #13 (open)                                      | In progress |
| OPS    | Containers and CI                                                                                                                                                           | `chore/devops-containers-ci`     | Yes     | #7 (open)                                       | In progress |
| QA     | QA harness                                                                                                                                                                  | `test/qa-harness`                | Yes     | #9 (open)                                       | In progress |
| SEC    | Threat model                                                                                                                                                                | `docs/security-threat-model`     | Yes     | #4 (open)                                       | In progress |
| INT | Notifications and email | `feat/notifications-email` | Yes | #11 (open); #19 `feat/integrations-webhooks-jira` (open) | In progress |
| MEDIA | Storage and media core | `feat/storage-and-media-core` | Yes | #10 (open); #16 `feat/realtime-scaffold` (open) | In progress |
| NATIVE | Extension scaffold | `feat/extension-scaffold` | Yes | #5 (open); #15 `feat/extension-capture` (open, stacked on #5) | In progress |
| DOC    | P1-DOC #3; P1-DOC-2 #8 (`docs/getting-started`); P1-DOC-3 #12 (`docs/database-and-devops`); P1-DOC-4 #14 (`docs/storage-testing-extension`); P1-DOC-5 #18 (`docs/contributing`); P1-DOC-6 (`docs/contracts`) | `docs/agent-board-and-providers` | Yes     | #3 (open)                                       | In progress |

Update the branch column when each agent pushes its branch.

## Later phases

- Phase 2: Meetings, uploads, FFmpeg pipeline
- Phase 3: Transcription, reports, task drafts
- Phase 4: Review/approval, notifications
- Phase 5: GitHub/Jira integrations, 2-way sync
