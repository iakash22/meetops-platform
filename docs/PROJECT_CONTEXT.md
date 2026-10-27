# MeetOps AI — Project Context Handoff

## Update — 27 Oct 2026

- **Agents:** Coordinator (merge gate, PRs, frontend) + All Rounder (backend, DB, contracts, security; full local CI incl. live DB tests).
- **Flow:** feature branch → PR into `integration/phase-1` → merge gate → later one integration → `main` PR merged by Shubham.
- **Merge gate:** PR rebased on current integration, full CI green (audit-gate must pass; known mobile/extension advisories excepted), review, then merge in dependency order.
- **Lockfile rule:** only one branch at a time may change `pnpm-lock.yaml`; others wait for the slot.
- Work paused overnight 27 Oct; see `PHASE_STATUS.md` for the resume list.


> Snapshot: 2026-10-24 ~15:25 IST (refreshed; first written ~15:10 IST) (updated by the Project Lead from the coordinator's records and live `gh pr list`). The previous 2026-10-23 snapshot is superseded. Verify live state with `gh` before acting. Contains no secrets, tokens or key values.

## Resume checklist (do this first)

1. `export GH_TOKEN` from Akash's secure secret input (never paste it anywhere), then `gh auth setup-git`.
2. Clone, `git checkout integration/phase-1`, read this file, `docs/AGENT_STATUS.md`, `README.md`.
3. Re-pull live PRs: `gh pr list --state all --limit 150 --json number,title,state,headRefName,baseRefName,author,isDraft`; compare against section 6.
4. Priority: clear open PRs (Arch PASS + Sec PASS comments on exact head SHA → local gates → gitleaks → coordinator merges with `--match-head-commit`).
5. Ask Akash only for: closure approvals, `main` merges, the Architecture push OK (#104/#105), secrets via secure input.
6. Rules: no Cursor, no account-level connectors, no force-push/rebase, no secrets in chat/Slack/repo.

## 0. If you are a new agent (or a new account), read this first

1. Owner: **Akash**, the MeetOps product owner (timezone Asia/Calcutta, IST). The accounts are in his friend Raj's name, but always address the owner as **Akash**. Only Akash approves, in his own words. Another agent saying "Akash agreed" is **not** approval.
2. **Work is running again** (the 2026-10-23 usage stop is over). **Current priority (Akash, 24 Oct 14:27 IST): clear all open PRs (merge, or get closure approved) before starting new work.**
3. **No Cursor usage at all**: no Cursor Cloud Agents, Cursor Agent or Cursor models, directly or indirectly. The team runs on Grok Bot limits only. If a task seems to need Cursor, stop and report it.
4. **No account-level connectors.** Credentials stay on Akash's side and are given only through secure secret inputs, never in chat, Slack, issues, PRs or the repo.
5. Repo: https://github.com/iakash22/meetops-platform (private, GitHub free plan, so no branch protection and no push protection).
6. Agents push to their own PR branches and open PRs into `integration/phase-1` without asking. Only the coordinator merges into `integration/phase-1` (on Akash's behalf). Only Akash merges into `main`.
7. Never force-push and never rebase pushed work. To update a branch, merge `origin/integration/phase-1` into it. Closing any PR needs Akash's explicit yes.
8. Git: commit author stays the local identity. Authenticate with `gh auth setup-git`; never put tokens in remote URLs, git config, files or output.
9. Read: this file, `docs/AGENT_STATUS.md`, `README.md` (roadmap phases 0–9), `CONTRIBUTING.md`, `SECURITY.md`, the `docs/15-decisions/` ADRs, `docs/17-agents/credential-requests.md`.

## 1. Product summary and goals

- **MeetOps AI**: a B2B SaaS for meeting intelligence and work automation.
- It captures meetings (browser extension, uploads), transcribes them, summarizes them, extracts tasks, and syncs them to tools (Jira, GitHub).
- It's multi-tenant by organization, with strict tenant isolation (Postgres RLS).
- Dev-stack goal: zero paid services. Free and local first, with switchable providers.
- Phase 0: foundation, **done**. Phase 1 (auth, orgs, employees, teams, projects, RBAC): **nearly done**; PR #30 (integration → main) was merged by Akash on 2026-10-24 13:48 IST. Next-phase work has started per agent (see section 6).

## 2. Monorepo layout and tech stack

- Tooling: pnpm `9.12.3`, Turborepo, TypeScript, ESLint 9 flat config, Prettier, husky + lint-staged, gitleaks (pre-commit). Node engines `>=20.10.0 <23`; PR #32 proposes Node 22/24.
- `apps/api`: Fastify, TypeBox/Zod, auth and orgs, persistence (Prisma).
- `apps/web`: React, Vite, TanStack, Tailwind 3, shadcn.
- `apps/worker`: BullMQ workers (media pipeline, AI jobs).
- `apps/realtime`: realtime events.
- `apps/extension`: WXT MV3 browser extension (pairing per ADR-005). **Built.**
- `apps/desktop`: desktop app (offline recording). **Decided: Tauri.** Phase 8, no code yet.
- Mobile app (iOS/Android, offline recording): **Decided: React Native with Expo** (Phase 8). M1 Expo scaffold is open in PR #78.

Client apps at a glance: Web (built), Browser extension (built), Desktop (planned), Mobile (planned). Roadmap phases 0 to 9 are in `README.md` on `integration/phase-1`.

- `packages/contracts`: TypeBox API contracts (v0.3.2 merged).
- `packages/database`: Prisma, PostgreSQL, forced RLS.
- `packages/ai-core`: AI provider registry and model router (PR #21 and #47, not merged yet).
- `packages/media-core`: FFmpeg media helpers.
- `packages/storage`: StorageService (S3 SDK). `STORAGE_PROVIDER=minio|r2|s3`.
- `packages/queue`: BullMQ / Redis.
- `packages/config`, `packages/logger`: shared config and logging.
- `infra/compose/compose.dev.yml`: dev Postgres, Redis, MinIO (pgsty/silo pinned for local storage).
- `docs/00`–`18`: numbered documentation tree.

## 3. Architecture and key decisions

ADRs (in `docs/15-decisions/` on `integration/phase-1`):

- ADR-001: modular monolith.
- ADR-002: provider interfaces (every external service sits behind an adapter).
- ADR-003: contracts ownership.
- ADR-004: mapping between the DB and contracts.
- ADR-005: extension auth (pairing, single-use nonce, exact `sender.origin`, session-only tokens, rotating bearer tokens, refresh-family revocation).

Decisions:

- **AI**: switchable AI Provider Registry and Model Router.
  - LLM: Gemini (primary, `gemini-2.5-flash-lite`, free tier), OpenAI, Ollama, OpenAI-compatible.
  - STT: **AssemblyAI is the default for background transcription**, with a Whisper (faster-whisper, local) option. **No Deepgram.** Live streaming transcription and embeddings are deferred.
  - **Never fall back automatically to a paid provider.** No arbitrary user-supplied endpoints (SSRF guard; remote endpoints must use port 443).
- **Storage**: MinIO in dev, R2 or S3 in production. Postgres stores file metadata only.
- **Email**: Gmail SMTP via Nodemailer (`smtp.gmail.com:465`), behind an EmailService adapter, with a BullMQ email queue. No paid email in dev.
- **Frontend**: stay on Tailwind 3 under a `braces@3.0.3` risk exception, up for review 2026-11-20. Frontend owns the Tailwind 4 migration before then.
- Dependabot and the dependency graph are on.
- No covert recording, and no bypassing platform permissions.
- **Storage keys (ADR-010, approved by Akash)**: object keys move from `org/` to `organizations/{organizationId}/`. Plan: dev wipe and reseed, a staging copy, and reads of old `org/` keys kept until the copy is verified. `organizationId` is the canonical tenant key.
- PR housekeeping (approved): #57's E2E flow tests moved to `test/qa-hardening-1` (#107, merged) and #57 is closed. #33 is closed (approved); #36, #58, #62 and #64 are closed.

## 4. Contracts and conventions

- IDs: UUIDs; the tenant key is `organizationId`/`orgId`. The old `tenantId` is being renamed (#47 notes that stored AI configs need a data migration).
- RLS: forced RLS on tenant tables. The `meetops_relay` role is NOBYPASSRLS and has no table privileges.
- Security defaults: CSRF retry runs once; open redirects are blocked; upload cap is tied to `MAX_MEDIA_BYTES` (2 GB); secrets are never logged.
- Commits: small, step-by-step, conventional commits (commitlint is proposed in #26).
- Before every PR: build, lint, typecheck, test, and gitleaks.
- **Merge gate**, all required:
  1. Green CI. **TEMPORARY**: the repo is out of free GitHub Actions minutes, so local gates (build, lint, typecheck, tests and the secrets scan) replace green CI until the minutes are back (Akash confirmed 24 Oct 15:06 IST). Use `gh run list` / `gh run view` when CI runs again (the token can't read the checks API).
  2. Architecture PASS posted as a PR comment on the exact head SHA.
  3. Security PASS posted as a PR comment on the exact head SHA.
  4. A clean gitleaks scan, e.g. `gitleaks git --redact --log-opts="origin/integration/phase-1..<head>"`. The only allowed exception is the two fake values in `packages/ai-core/test/credential-ref.test.ts:26`.
  5. Merge (coordinator only) with `gh pr merge N --merge --match-head-commit <sha>`.
- If only `pnpm-lock.yaml` has changed since the approved head, no re-review is needed.
- Stacked PRs: retarget them to `integration/phase-1` once their parent merges.

## 5. Team roster

- **Project Lead** and **Project Plan and Coordinator** (coordinator merges into integration on Akash's behalf).
- Agents: Architecture, Security, Backend, Frontend, Database, DevOps, Media and Realtime, AI, Integrations, Native Apps, QA, Documentation.
- All agents report to the coordinator; Project Lead reports to Akash. Per-agent status is in `docs/AGENT_STATUS.md`.

| Agent              | Owns                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| Architecture       | system design, monorepo, contracts, ADRs, boundary lint, reviews          |
| Security           | threat model, auth, tenancy, reviews                                      |
| Backend            | `apps/api`                                                                |
| Frontend           | `apps/web`                                                                |
| Database           | `packages/database`                                                       |
| DevOps             | `infra/`, `.github/workflows`, scripts, deps                              |
| Media and Realtime | `apps/realtime`, `packages/media-core`, `packages/storage`, FFmpeg worker |
| AI                 | `packages/ai-core`, AI worker jobs                                        |
| Integrations       | `packages/integrations` (GitHub App, Jira)                                |
| Native Apps        | `apps/extension`, `apps/desktop` (Tauri), mobile (Expo)                   |
| QA                 | tests and test suites                                                     |
| Documentation      | `docs/`, READMEs                                                          |

## 6. Phase status

Current phase report (done, in progress, and still open), taken from `main` on 2026-10-25: [`docs/PHASE_STATUS.md`](PHASE_STATUS.md). The bullets below are the 2026-10-24 ~15:25 IST snapshot.

Roadmap (`README.md`): 0 foundation · 1 auth/orgs/employees/teams/projects/RBAC · 2 meetings, uploads, recording, FFmpeg · 3 transcription, reports, task drafts · 4 task review/notifications · 5 GitHub/Jira two-way sync · 6 live transcription + extension · 7 calendar/imports/search/analytics · 8 desktop + mobile offline recording · 9 production hardening, billing, release.

- **Phase 0: done.**
- **Phase 1: nearly done.** `integration/phase-1` head `ac96ad7` (2026-10-24 ~15:25 IST). #30 merged to `main` by Akash at 13:48 IST; later integration work reaches `main` only through a new PR that Akash merges.
- **Next-phase work started per agent**: tenant key migration (Database, Media), S3/MinIO uploads and FFmpeg worker (Media), Expo app (Native Apps), GitHub App and pairing (Integrations/Frontend), CI hardening (DevOps), contracts v0.3.3 and boundary lint (Architecture, Backend), transcription and summaries (AI).

### Open PRs (live, 2026-10-24 ~15:25 IST; owner inferred from branch name)

**Changes since the 15:10 IST snapshot (live at ~15:25 IST):** #75 (ai-core org naming), #81 (ADR-010) and #87 (storage organization refs) were **merged** into integration; #109 (this handover PR, base `main`) was **opened**. `integration/phase-1` head is now `ac96ad7`.

Review note: Security PASS status above was read from PR comments. **No Architecture PASS/FAIL comments were found on any open PR** with the token's comment view, so Architecture status is **unverified** (it may be recorded elsewhere, e.g. agent chats); treat every open PR as needing an Arch PASS on its exact head SHA. Mergeability: only #78 reports a conflict; most others reported UNKNOWN (GitHub had not computed it), #83, #99, #100 report MERGEABLE.

| Agent (from branch) | PR                                                            | Branch → base                                                  | Head      | Security PASS comment                | Title                                                                                                           |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| AI                  | [#83](https://github.com/iakash22/meetops-platform/pull/83)   | `feat/ai-worker-transcription` → `integration/phase-1`         | `087b556` | PASS on head                         | feat(worker): AI transcription consumer                                                                         |
| Architecture        | [#104](https://github.com/iakash22/meetops-platform/pull/104) | `feat/contracts-cursor-page-conflicts` → `integration/phase-1` | `2b411c4` | none                                 | feat(contracts): v0.3.3 conflict reasons, page limits, /types default condition                                 |
| Architecture        | [#105](https://github.com/iakash22/meetops-platform/pull/105) | `chore/boundary-lint` → `integration/phase-1`                  | `2ceb86f` | none                                 | chore(lint): enforce module boundary imports                                                                    |
| Backend             | [#98](https://github.com/iakash22/meetops-platform/pull/98)   | `fix/api-lockout-redis` → `integration/phase-1`                | `71cf1a8` | PASS on head                         | fix(api): atomic redis lockout counters, Redis lockout wiring, lockout notice email                             |
| Backend             | [#103](https://github.com/iakash22/meetops-platform/pull/103) | `fix/api-error-envelope` → `integration/phase-1`               | `0dd4d6e` | PASS on head                         | fix(api): contracts v0.3.3 error envelope (reason, LAST_OWNER 409, organizationId params)                       |
| Database            | [#89](https://github.com/iakash22/meetops-platform/pull/89)   | `feat/db-tenant-isolation-tests` → `integration/phase-1`       | `107cb64` | PASS on head                         | test(database): per-table cross-organization RLS isolation (ADR-010)                                            |
| Database            | [#91](https://github.com/iakash22/meetops-platform/pull/91)   | `feat/db-seeds-organizations` → `integration/phase-1`          | `c9c0c8a` | PASS on head                         | feat(database): multi-organization seed (ADR-010)                                                               |
| Database            | [#93](https://github.com/iakash22/meetops-platform/pull/93)   | `feat/db-ai-usage-transcripts` → `integration/phase-1`         | `faa2ff7` | PASS on head                         | feat(database): AI usage counters, idempotency, org config and transcript chunks with RLS                       |
| Database            | [#97](https://github.com/iakash22/meetops-platform/pull/97)   | `feat/db-recording-chunks` → `integration/phase-1`             | `6398b00` | none                                 | feat(database): recordings.chunk_count, chunk FileObject repository + lookup for Media #92                      |
| Database            | [#100](https://github.com/iakash22/meetops-platform/pull/100) | `feat/db-key-prefix-transition` → `integration/phase-1`        | `c049c4c` | none                                 | feat(database): accept org/ and organizations/ storage key prefixes (ADR-010 phase A)                           |
| DevOps              | [#7](https://github.com/iakash22/meetops-platform/pull/7)     | `chore/devops-containers-ci` → `integration/phase-1`           | `e7e5cfa` | none                                 | chore(devops): Dockerfiles, compose.app, docker CI, audit, dependabot, CODEOWNERS                               |
| DevOps              | [#26](https://github.com/iakash22/meetops-platform/pull/26)   | `chore/commitlint` → `integration/phase-1`                     | `8629f10` | none                                 | chore: add commitlint commit-msg hook                                                                           |
| DevOps              | [#32](https://github.com/iakash22/meetops-platform/pull/32)   | `chore/windows-node24-setup` → `integration/phase-1`           | `6f59edc` | none                                 | chore: Windows and Node 24 dev setup                                                                            |
| DevOps              | [#40](https://github.com/iakash22/meetops-platform/pull/40)   | `chore/fast-pre-commit` → `integration/phase-1`                | `96092ca` | none                                 | chore(hooks): fast pre-commit, type-aware checks on pre-push                                                    |
| DevOps              | [#95](https://github.com/iakash22/meetops-platform/pull/95)   | `fix/compose-dev-minio` → `integration/phase-1`                | `23be850` | none                                 | fix(compose): replace unpullable minio/minio and minio/mc images                                                |
| DevOps              | [#99](https://github.com/iakash22/meetops-platform/pull/99)   | `chore/nodemailer-10` → `integration/phase-1`                  | `8ee3d2e` | PASS on head                         | chore(deps): nodemailer 10.2.1 (high-severity advisories)                                                       |
| DevOps              | [#101](https://github.com/iakash22/meetops-platform/pull/101) | `chore/testcontainers-11` → `integration/phase-1`              | `2d14358` | none                                 | chore(deps): testcontainers 11 (undici / @fastify/busboy high advisories)                                       |
| DevOps              | [#102](https://github.com/iakash22/meetops-platform/pull/102) | `chore/vitest-4-upgrade` → `integration/phase-1`               | `636d33e` | none                                 | chore(deps): vitest 4.1.12 + web vite 7 (GHSA-82fw-gwwq-j7x9, vite advisories)                                  |
| Documentation       | [#31](https://github.com/iakash22/meetops-platform/pull/31)   | `docs/refresh-heads` → `integration/phase-1`                   | `b13b4d8` | PASS on older SHA (re-review needed) | docs: refresh DB/ops pages, auth and orgs API, integration merge flow (P1-DOC-8)                                |
| Documentation       | [#56](https://github.com/iakash22/meetops-platform/pull/56)   | `docs/merged-phase1` → `docs/refresh-heads`                    | `8598338` | PASS on head                         | docs: auth, contracts v0.2 and extension pages for merged Phase 1 PRs; board refresh                            |
| Documentation       | [#80](https://github.com/iakash22/meetops-platform/pull/80)   | `docs/zod4-migration-plan` → `integration/phase-1`             | `8212031` | PASS on older SHA (re-review needed) | docs: zod 4 migration plan                                                                                      |
| Media and Realtime  | [#77](https://github.com/iakash22/meetops-platform/pull/77)   | `feat/media-security-followups` → `integration/phase-1`        | `f40fc15` | PASS on older SHA (re-review needed) | feat(media): security follow-ups — 1.4 GB cap, required sha256, single-use presigned uploads                    |
| Media and Realtime  | [#82](https://github.com/iakash22/meetops-platform/pull/82)   | `feat/media-organization-keys` → `integration/phase-1`         | `be5c5ce` | PASS on older SHA (re-review needed) | feat(storage)!: organizations/{organizationId}/ object keys (stacked on #77)                                    |
| Media and Realtime  | [#85](https://github.com/iakash22/meetops-platform/pull/85)   | `feat/media-upload-verify` → `integration/phase-1`             | `1420cac` | PASS on older SHA (re-review needed) | feat(storage): idempotent verify-on-complete {verified:true, sha256} (stacked on #82)                           |
| Media and Realtime  | [#88](https://github.com/iakash22/meetops-platform/pull/88)   | `feat/media-ffmpeg-worker` → `integration/phase-1`             | `6fa0b5c` | PASS on older SHA (re-review needed) | feat(media): waveform artifact for the STT normalisation pipeline (stacked on #82)                              |
| Media and Realtime  | [#90](https://github.com/iakash22/meetops-platform/pull/90)   | `feat/media-realtime-status` → `integration/phase-1`           | `954aa9a` | PASS on older SHA (re-review needed) | feat(realtime): organizations:{organizationId} rooms and typed upload/processing status events (stacked on #88) |
| Media and Realtime  | [#92](https://github.com/iakash22/meetops-platform/pull/92)   | `feat/media-audio-resolver` → `integration/phase-1`            | `2f055c4` | PASS on older SHA (re-review needed) | feat(media): organization-scoped chunk audio resolver + chunk-count port (stacked on #82)                       |
| Media and Realtime  | [#94](https://github.com/iakash22/meetops-platform/pull/94)   | `fix/storage-checksum-hex` → `integration/phase-1`             | `2506469` | none                                 | fix(storage)!: checksumSha256 as lowercase hex at the S3 boundary (stacked on #85)                              |
| Media and Realtime  | [#96](https://github.com/iakash22/meetops-platform/pull/96)   | `docs/storage-key-migration-runbook` → `integration/phase-1`   | `33abe7e` | none                                 | docs(runbooks): storage key migration (dev wipe/reseed + staging copy)                                          |
| Native Apps         | [#78](https://github.com/iakash22/meetops-platform/pull/78)   | `feat/mobile-scaffold` → `integration/phase-1`                 | `f037dee` | PASS on head · **merge conflict**    | feat(mobile): M1 Expo app scaffold (expo-router, strict TS, jest-expo)                                          |
| Project Lead        | [#109](https://github.com/iakash22/meetops-platform/pull/109) | `docs/handover-context-main-2026-10-24` → `main`               | ``        |                                      | docs: handover context update (24 Oct 2026)                                                                     |
| QA                  | [#34](https://github.com/iakash22/meetops-platform/pull/34)   | `ci/qa-jobs` → `integration/phase-1`                           | `9ab3b00` | none                                 | ci: add QA integration (required) and e2e (informational) jobs                                                  |

### Merged and closed (all time)

Merged: #1, #2, #3, #4, #8, #9, #10, #11, #12, #13, #14, #16, #17, #18, #19, #21, #22, #23, #24, #27, #28, #29, #30, #35, #38, #39, #47, #48, #49, #50, #51, #52, #53, #55, #59, #60, #61, #63, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #76, #79, #81, #84, #86, #87, #106, #107, #108

Closed (not merged): #5, #6, #15, #20, #25, #33, #36, #37, #41, #42, #43, #44, #45, #46, #57, #58, #62, #64

### Next integration → main PR

#30 (integration/phase-1 → main) was merged by Akash on 2026-10-24 13:48 IST. Everything merged into `integration/phase-1` after that (e.g. #75, #81, #86, #87, #106, #107, #108 and later merges) is **not on `main`** yet. Once the open PRs are cleared, the coordinator opens a **new** `integration/phase-1 → main` PR; **only Akash merges it**.

## 7. Open decisions and environment blockers

Waiting on Akash:

- The Architecture push OK for contracts v0.3.3 and boundary lint (#104, #105) needs Akash's own line in Architecture's own chat.
- Optional: rotate the GitHub token.
- `main` merges (Akash only).
- Closure approval for any open PR that won't be merged.

Environment:

- Docker isn't running on Akash's PC.
- GitHub Actions free minutes are exhausted: local gates replace CI (section 4) until they return.
- The Grok Bot box has no Docker; run heavy gates sequentially (`--concurrency=1`).

## 8. Next steps (priority order)

1. Clear all open PRs (section 6): reviews (Arch + Sec on exact head SHA), local gates, gitleaks, coordinator merges; stacked PRs retarget after their parent merges.
2. Get Akash's yes for any PR to close instead of merge.
3. Akash merges integration into `main` via a new PR.
4. Then continue next-phase work per agent.

## 9. Setup and run

```bash
git clone https://github.com/iakash22/meetops-platform && cd meetops-platform
git checkout integration/phase-1
corepack enable && corepack prepare pnpm@9.12.3 --activate
pnpm install --frozen-lockfile
cp .env.example .env        # fill values locally; never commit
pnpm dev:infra:up           # Postgres, Redis, MinIO via Docker Compose
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm dev
```

- Windows: Akash's clone is `E:\Project\meetops-platform`. See the Windows setup guide in #28 once it merges.
- Env var reference: `docs/00-getting-started/environment-variables.md`.

## 10. How to resume on a new account

1. Read `docs/PROJECT_CONTEXT.md` (this file), `docs/AGENT_STATUS.md` and `README.md` (roadmap phases 0–9).
2. Authenticate with the token Akash provides through a secure secret input (env var `GH_TOKEN`), then run `gh auth setup-git`. Never paste tokens into chat, URLs, git config or files.
3. Get live PR state: `gh pr list --state all --limit 150 --json number,title,state,headRefName,baseRefName,author,isDraft` (don't request check fields; the token can't read them). Match open PRs to owners using the table in section 6.
4. Review and merge flow: agent pushes to its own branch and opens a PR into `integration/phase-1` → Architecture PASS and Security PASS comments on the exact head SHA → local gates (build, lint, typecheck, tests, secrets scan) while Actions minutes are out → clean gitleaks → coordinator runs `gh pr merge N --merge --match-head-commit <sha>`. Only Akash merges into `main`.
5. Secrets: all credentials come from Akash via secure secret inputs only. Never commit them, never put them in Slack, chat, PRs or docs. `.env` stays local (`cp .env.example .env`).
6. Rules recap: no Cursor; no account-level connectors; no force-push or rebase of pushed work; closing a PR needs Akash's explicit yes.
