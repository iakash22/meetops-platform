# Implementation board

Last updated: 2026-10-21. Branch names are assigned by the Coordinator. PR numbers and states come from `git ls-remote` and `gh pr list --state all` on that date.

## Phase 0: Foundation — Done (merged)

Monorepo, apps (api/web/worker), packages, Docker Compose, CI. Branch `chore/phase-0-foundation`: PR #1 (original scaffold) and PR #2 (Phase 0 fixes) both merged to `main`.

## Phase 1: In progress

| Agent | Workstream | Branch | PRs | Status |
| --- | --- | --- | --- | --- |
| ARCH | Core contracts, ADRs | `feat/core-contracts` | #17 merged; #22 (ADR-004) merged | Merged into integration |
| DB | Schema, tenancy and RLS | `feat/database-core-schema` | #6 open; #25 `feat/database-tenancy-rls` open (stacked on #6) | Open |
| AI | AI provider registry | `feat/ai-provider-registry` | #21 open | Open |
| BE | API auth, orgs and users | `feat/api-auth-orgs` | #27 open | Open |
| FE | Web shell | `feat/web-shell` | #13 open | Open |
| OPS | Containers, CI, tooling | `chore/devops-containers-ci` | #7 open; #24 `fix/eslint-project-service` open; #26 `chore/commitlint` open | Open |
| QA | QA harness | `test/qa-harness` | #9 open; #29 `test/db-and-security-suites` open (stacked on #9) | Open |
| SEC | Threat model | `docs/security-threat-model` | #4 merged | Merged into integration |
| INT | Notifications, integrations | `feat/notifications-email` | #11 open; #19 `feat/integrations-webhooks-jira` open | Open |
| MEDIA | Storage, media core, realtime | `feat/storage-and-media-core` | #10 open; #16 `feat/realtime-scaffold` open | Open |
| NATIVE | Extension | `feat/extension-scaffold` | #5 open; #15 `feat/extension-capture` open (stacked on #5) | Open |
| DOC | Docs | `docs/*` | #3, #8, #12, #14, #18, #23 merged; #28 `docs/windows-local-setup` open; P1-DOC-8 `docs/refresh-heads` open | In progress |

Integration: `integration/phase-1` → `main` is PR #30, merged by Akash once all Phase 1 PRs land.

Update the branch column when each agent pushes its branch.

## Later phases

- Phase 2: Meetings, uploads, FFmpeg pipeline
- Phase 3: Transcription, reports, task drafts
- Phase 4: Review/approval, notifications
- Phase 5: GitHub/Jira integrations, 2-way sync
