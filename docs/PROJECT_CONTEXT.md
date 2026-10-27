# MeetOps AI — Project Context Handoff

## Update — 27 Oct 2026 (~23:20 IST)

- Since ~21:30 IST: #249/#250 (ADR-013 notifications plan, Proposed), #251 (real mail transport + Resend provider) and the integration → `main` PRs #252, #253 merged. `main` is at `02646a1` and contains `integration/phase-1` up to `99a6f4f`.
- Open PRs: five drafts, all into `integration/phase-1` (see section 6): #192, #193, #199 (ADR amendments) and #254, #255 (backups, do not merge).
- `apps/desktop` and `apps/mobile` are real apps now (see section 2). Sections 2, 3 and 6 were refreshed on this date; the other sections are still the 24 Oct snapshot.

## Update — 27 Oct 2026 (~21:30 IST)

- `integration/phase-1` was merged into `main` via #247 (merge commit `47dbf97`); `main` now carries Phases 0–9 work to date (overall ~60%, see [`PHASE_STATUS.md`](PHASE_STATUS.md)).
- Agents: All Rounder (backend) and the coordinator (frontend: web, extension, mobile, desktop). Both idle until Shubham says "start work".
- Desktop auth (#241) is behind `DESKTOP_AUTH_ENABLED` (default off).
- Pending owner decisions and keys: see `PHASE_STATUS.md` → "Owner decisions". No secrets in docs.

## Update — 27 Oct 2026 (morning)

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
- `apps/desktop`: Tauri 2 desktop app (Phase 8). Meetings, tasks and task review (#232), a consent-gated recording screen (webview `MediaRecorder` in 10 s chunks) and an upload queue. The Rust side registers `app_info` and `api_request`; the ADR-012 keychain/PKCE commands are still pending (backup PR #254). The API's desktop auth (#241) is off unless `DESKTOP_AUTH_ENABLED` is set. Bundle id is still `ai.meetops.desktop.todo-owner`.
- `apps/mobile`: Expo SDK 52 / React Native 0.76 app (Phase 8). Auth (demo mode unless `EXPO_PUBLIC_API_URL` is set), consent UI, task review (#233), and the M5 upload queue engine (`src/upload/uploadQueueEngine.ts`) fed by a simulated recorder. Tokens are in memory until `expo-secure-store` lands (backup PR #255). Bundle id is still `com.example.meetops`. Plan: `docs/mobile/plan.md`.

Client apps at a glance: Web (built), Browser extension (built), Desktop (built, Phase 8 in progress), Mobile (built, Phase 8 in progress). Roadmap phases 0 to 9 are in `README.md`.

- `packages/contracts`: TypeBox API contracts (`0.9.0` in `packages/contracts/package.json`).
- `packages/database`: Prisma, PostgreSQL, forced RLS.
- `packages/ai-core`: AI provider registry and model router (#21, #47 merged).
- `packages/media-core`: FFmpeg media helpers.
- `packages/storage`: StorageService (S3 SDK). `STORAGE_PROVIDER=minio|r2|s3`.
- `packages/queue`: BullMQ / Redis.
- `packages/config`, `packages/logger`: shared config and logging.
- `packages/integrations`: GitHub and Jira adapters, OAuth, webhooks.
- `packages/notifications`: `EmailService` (SMTP, Resend, console) and email templates.
- `packages/session-verifier`: session/token verification shared by the API and realtime.
- `infra/compose/compose.dev.yml`: dev Postgres, Redis, MinIO (pgsty/silo pinned for local storage).
- `docs/00`–`18`: numbered documentation tree.

## 3. Architecture and key decisions

ADRs (in `docs/15-decisions/` on `integration/phase-1`):

- ADR-001: modular monolith.
- ADR-002: provider interfaces (every external service sits behind an adapter).
- ADR-003: contracts ownership.
- ADR-004: mapping between the DB and contracts.
- ADR-005: extension auth (pairing, single-use nonce, exact `sender.origin`, session-only tokens, rotating bearer tokens, refresh-family revocation).
- ADR-006 to ADR-013 (Proposed): login lockout, integrations retry/webhook replay, OAuth PKCE + token encryption, AI routing/SSRF, `organizationId` tenant key, realtime auth, desktop auth, notifications. Index: `docs/15-decisions/README.md`.

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

Current phase report: [`docs/PHASE_STATUS.md`](PHASE_STATUS.md) (overall ~60%, coordinator estimate, 27 Oct 2026).

Roadmap (`README.md`): 0 foundation · 1 auth/orgs/employees/teams/projects/RBAC · 2 meetings, uploads, recording, FFmpeg · 3 transcription, reports, task drafts · 4 task review/notifications · 5 GitHub/Jira two-way sync · 6 live transcription + extension · 7 calendar/imports/search/analytics · 8 desktop + mobile offline recording · 9 production hardening, billing, release.

### Open PRs (live `gh pr list --state open`, 2026-10-27 ~23:15 IST)

| PR                                                            | Branch → base                                                  | Head      | Draft | Title                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------- | --------- | ----- | ------------------------------------------------------------------------------------- |
| [#192](https://github.com/iakash22/meetops-platform/pull/192) | `docs/adr-012-desktop-amendment` → `integration/phase-1`       | `ebce7de` | Yes   | docs(adr-012): desktop auth amendment (authorize, token, refresh, revoke, switch-org) |
| [#193](https://github.com/iakash22/meetops-platform/pull/193) | `docs/adr-005-mobile-header-token` → `integration/phase-1`     | `16f3843` | Yes   | docs(adr-005): mobile header-token amendment                                          |
| [#199](https://github.com/iakash22/meetops-platform/pull/199) | `docs/adr-005-extension-consent-route` → `integration/phase-1` | `fbd0013` | Yes   | docs(adr-005): extension consent route amendment (needs owner sign-off)               |
| [#254](https://github.com/iakash22/meetops-platform/pull/254) | `backup/desktop-native-unpushed` → `integration/phase-1`       | `3acc1c0` | Yes   | [INFO] backup: unpushed desktop native commits (do not merge)                         |
| [#255](https://github.com/iakash22/meetops-platform/pull/255) | `backup/mobile-securestore-unpushed` → `integration/phase-1`   | `6233a8b` | Yes   | [INFO] backup: unpushed mobile secure-store commits (do not merge)                    |

Every PR in the 24 Oct open-PR table that used to be here has since merged, except #31 and #56, which were closed.

### Recently merged (27 Oct 2026, IST)

- Into `integration/phase-1`: #205–#209 and #212–#246 (see `PHASE_STATUS.md` for the per-phase list), then #249 (ADR-013 plan) and #251 (mail transport + Resend).
- Into `main`: #211 and #247 (integration → `main`), #248 (status docs), #250 (ADR-013 plan), #252 and #253 (integration → `main`).

### Totals (live `gh pr list`, 2026-10-27)

226 merged, 23 closed without merging (#5, #6, #15, #20, #25, #31, #33, #36, #37, #41, #42, #43, #44, #45, #46, #56, #57, #58, #62, #64, #110, #111, #113), 5 open.

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
