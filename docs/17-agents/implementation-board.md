# Implementation board

Last updated: 2026-10-21. Branch names are assigned by the Coordinator. "Pushed?" and PR numbers come from `git ls-remote` and `gh pr list --state all` on that date.

## Phase 0: Foundation — Done (merged)

Monorepo, apps (api/web/worker), packages, Docker Compose, CI. Branch `chore/phase-0-foundation`: PR #1 (original scaffold) and PR #2 (Phase 0 fixes) both merged to `main`.

## Phase 1: In progress

| Agent  | Workstream                                                  | Branch                           | Pushed? | PR   | Status      |
| ------ | ----------------------------------------------------------- | -------------------------------- | ------- | ---- | ----------- |
| ARCH   | Core contracts                                              | `feat/core-contracts`            | Not yet | None | In progress |
| DB     | Database schema and migrations                              | `feat/database-core-schema`      | Yes     | None | In progress |
| AI     | AI provider registry                                        | `feat/ai-provider-registry`      | Not yet | None | In progress |
| BE     | API auth and organizations                                  | `feat/api-auth-orgs`             | Not yet | None | In progress |
| FE     | Web shell                                                   | `feat/web-shell`                 | Not yet | None | In progress |
| OPS    | Containers and CI                                           | `chore/devops-containers-ci`     | Yes     | None | In progress |
| QA     | QA harness                                                  | `test/qa-harness`                | Not yet | None | In progress |
| SEC    | Threat model                                                | `docs/security-threat-model`     | Yes     | None | In progress |
| INT    | Notifications and email                                     | `feat/notifications-email`       | Not yet | None | In progress |
| MEDIA  | Storage and media core                                      | `feat/storage-and-media-core`    | Not yet | None | In progress |
| NATIVE | Extension scaffold                                          | `feat/extension-scaffold`        | Yes     | None | In progress |
| DOC    | Agent board, credential requests, AI provider docs (P1-DOC) | `docs/agent-board-and-providers` | Yes     | #3   | In progress |

Update the branch column when each agent pushes its branch.

## Later phases

- Phase 2: Meetings, uploads, FFmpeg pipeline
- Phase 3: Transcription, reports, task drafts
- Phase 4: Review/approval, notifications
- Phase 5: GitHub/Jira integrations, 2-way sync
