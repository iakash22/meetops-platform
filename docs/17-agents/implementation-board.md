# Implementation board

Last updated: 2026-10-21. Branch names come from `git ls-remote --heads origin` on that date; agents without a pushed branch are marked `TBD`.

## Phase 0: Foundation — Done (merged)

Monorepo, apps (api/web/worker), packages, Docker Compose, CI. Branch `chore/phase-0-foundation`, merged to `main` (PR #2).

## Phase 1: In progress

| Agent | Workstream | Branch | Status |
| --- | --- | --- | --- |
| DB | Database schema and migrations | TBD | In progress |
| AI | AI core, providers | TBD | In progress |
| BE | Backend API | TBD | In progress |
| FE | Web dashboard | TBD | In progress |
| OPS | DevOps, CI, infra | TBD | In progress |
| QA | Testing | TBD | In progress |
| SEC | Security | TBD | In progress |
| INT | Integrations | TBD | In progress |
| MEDIA | Storage and media pipeline | TBD | In progress |
| NATIVE | Desktop and mobile | TBD | In progress |
| DOC | Docs: agent board, credential requests, AI provider docs (P1-DOC) | `docs/agent-board-and-providers` | In progress |

Update the branch column when each agent pushes its branch.

## Later phases

- Phase 2: Meetings, uploads, FFmpeg pipeline
- Phase 3: Transcription, reports, task drafts
- Phase 4: Review/approval, notifications
- Phase 5: GitHub/Jira integrations, 2-way sync
