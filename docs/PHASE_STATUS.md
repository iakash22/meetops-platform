# Phase status — 3 Nov 2026 (~02:45 IST)

## Update — 3 Nov 2026 (~02:45 IST)

Tree: `integration/phase-1` at `0909a2b` (1:41 IST, 3 Nov). PR states read from the GitHub API at ~02:40 IST.
Percentages are coordinator estimates, not measured. Integration → `main` is open as [#384](https://github.com/iakash22/meetops-platform/pull/384).

Merged into `integration/phase-1` since 31 Oct (selected):

- P2/P3/P4: consent API (#334) and web consent UI (#345); durable AI stores (#335); AI store hardening (#357); task sync route + worker job behind `TASK_SYNC_ENABLED` (#349).
- P5: token refresh hardening (#354, #375), Jira refresh lease (#378, #382), lease follow-ups (#389).
- P7: calendar event↔meeting linking (#341), semantic search API behind a flag (#346), analytics endpoint (#348) and dashboard (#356, #376), calendar sync scheduler (#353), Outlook adapter (#390).
- P8: Android encrypted segments (#342), desktop legacy-root hardening (#355), Android Keystore key (#380), foreground-service resilience (#381, needs a device check), Rust 1.88 (#371).
- P9: clamd sidecar, network isolation and hardening (#377, #379, #388); dependency fixes (#364, #367); web bundle budget (#366, #370, #372, #383); responsive shell and toast retry (#361, #362).

Open PRs (base `integration/phase-1` unless noted):

| PR   | What                                                                       | Notes                                      |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------ |
| #350 | P7 semantic search embedding pipeline (2/2)                                | Depends on #346 (merged)                   |
| #347 | iOS Live Activity hardening                                                | Draft                                      |
| #385 | Delete calendar event links inside the revoke transaction                  |                                            |
| #386 | Task sync gated on a single approval read                                  |                                            |
| #387 | Consent hardening (backdate bound, seq ordering, upload consent)           |                                            |
| #391 | P9 dependency audit, security headers/CORS requirements, release checklist | Docs                                       |
| #392 | Per-org task, review and approval counts (P7 analytics)                    |                                            |
| #393 | P9 security headers, CORP, CSP reporting, env validation                   |                                            |
| #394 | Incremental calendar background sync                                       | Was stacked on #390 (now merged)           |
| #395 | Overrides for ajv >= 8.18.0 and esbuild >= 0.28.1                          | Lockfile change; other lockfile work waits |
| #396 | Validate `OUTLOOK_CALENDAR_TENANT` at startup                              |                                            |
| #398 | Calendar auto-link during background sync (flag, default off)              | Stacked on #394                            |
| #397 | Phase status refresh (this file)                                           | Docs                                       |
| #384 | `integration/phase-1` → `main`                                             | Base `main`                                |

| Phase                           | 31 Oct   | 3 Nov    | Still missing                                                                                                            |
| ------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| P0 Foundation                   | 100%     | 100%     | —                                                                                                                        |
| P1 Auth, orgs, roles            | ~95%     | ~95%     | Google OAuth client (Akash); MFA/SSO decision; ADR-006/010 sign-off                                                      |
| P2 Meetings, uploads, recording | ~85%     | ~90%     | Consent hardening (#387); consent-by-jurisdiction decision                                                               |
| P3 Transcripts, reports         | ~70%     | ~75%     | Gemini key (Akash) for the worker AI consumer                                                                            |
| P4 Tasks, approval              | ~75%     | ~85%     | #386; task sync is behind `TASK_SYNC_ENABLED`                                                                            |
| P5 GitHub, Jira                 | ~80%     | ~85%     | E2E on a throwaway repo with meetops-dev installed; real Jira credentials                                                |
| P6 Extension                    | ~85%     | ~85%     | Info items: Start fails open, unheld pending eviction, 8 MB vs 64 MB chunk                                               |
| P7 Calendar, search, analytics  | ~45%     | ~70%     | Background sync (#394), auto-link (#398, stacked on #394), embeddings indexer (#350), analytics counts (#392), #385/#396 |
| P8 Desktop, mobile              | ~75%     | ~85%     | iOS Live Activity (#347); device check for #381; iOS backup exclusion; real bundle ids                                   |
| P9 Hardening, release           | ~35%     | ~50%     | #391, #393, #395; billing; store submission; Windows test/cargo check; GitHub Actions failures                           |
| **Overall**                     | **~72%** | **~79%** |                                                                                                                          |

---

## Update — 31 Oct 2026 (~13:30 IST)

Tree: `integration/phase-1` at `a868a4c` (merge of #317). [#257](https://github.com/iakash22/meetops-platform/pull/257) was merged to `main` by Akash on 31 Oct. Percentages are coordinator estimates, not measured. Full handoff for a new agent: [HANDOFF.md](HANDOFF.md).

Merged into `integration/phase-1` today (#305–#317): extension real meeting API (#305) and held-recording cleanup/starvation fixes (#307, #308); auth mail queue (#306); GitHub App E2E harness (#309) and its Lows (#313, incl. wxt watcher ENOSPC fix); mobile M3–M4 recorder (#310), M5 storage/upload (#311), M6 hardening (#312); P7 calendar (#314), search (#315), web (#316), follow-ups (#317).

| Phase                           | 27 Oct PM | 31 Oct   | Still missing                                                                                          |
| ------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------ |
| P0 Foundation                   | 100%      | 100%     | —                                                                                                      |
| P1 Auth, orgs, roles            | ~90%      | ~95%     | Google OAuth client (Akash); MFA/SSO decision; ADR-006/010 sign-off                                    |
| P2 Meetings, uploads, recording | ~75%      | ~85%     | Desktop old chunk-folder migration; chunk_put JSON-array body                                          |
| P3 Transcripts, reports         | ~65%      | ~70%     | Gemini key (Akash) for the worker AI consumer                                                          |
| P4 Tasks, approval              | ~70%      | ~75%     | —                                                                                                      |
| P5 GitHub, Jira                 | ~65%      | ~80%     | E2E on a throwaway repo with meetops-dev installed; Jira credentials; #313 follow-ups                  |
| P6 Extension                    | ~70%      | ~85%     | Info items: Start fails open, unheld pending eviction, 8 MB vs 64 MB chunk                             |
| P7 Calendar, search, analytics  | 5%        | ~45%     | Background sync job, Outlook adapter, event↔meeting linking, pgvector semantic search, analytics       |
| P8 Desktop, mobile              | ~55%      | ~75%     | Android foreground service, iOS Live Activity, Android Keystore, iOS backup exclusion; real bundle ids |
| P9 Hardening, release           | ~25%      | ~35%     | Dependabot, billing, store submission, Windows test/cargo check                                        |
| **Overall**                     | **~60%**  | **~72%** |                                                                                                        |

---

## Update — 27 Oct 2026 (~23:20 IST)

Checked against `gh pr list` / `gh pr view` and the tree at `integration/phase-1` `99a6f4f` and `main` `02646a1`. Phase percentages below are unchanged (coordinator estimates, not measured).

- Merged after the ~21:30 IST snapshot:
  - [#249](https://github.com/iakash22/meetops-platform/pull/249) (into `integration/phase-1`, 22:40 IST) and [#250](https://github.com/iakash22/meetops-platform/pull/250) (into `main`, 22:41 IST): notifications architecture plan and [ADR-013](15-decisions/ADR-013-notifications-architecture.md) (Proposed).
  - [#251](https://github.com/iakash22/meetops-platform/pull/251) (into `integration/phase-1`, 22:46 IST): the API now wires the real mailer (`EMAIL_PROVIDER=smtp|resend|console`) and `packages/notifications` gains a Resend provider. Production still needs the BullMQ mail queue.
  - [#252](https://github.com/iakash22/meetops-platform/pull/252) (22:42 IST) and [#253](https://github.com/iakash22/meetops-platform/pull/253) (22:48 IST): `integration/phase-1` → `main`. `main` now contains everything on `integration/phase-1` up to `99a6f4f`.
- `main` also carries docs merged directly into it (#248 status update, #250), which `integration/phase-1` did not have until this docs PR merged `main` back in.
- Open PRs (all drafts, base `integration/phase-1`): #192, #193, #199 (ADR amendment drafts, need owner sign-off) and #254, #255 (backup branches for unpushed desktop-native and mobile secure-store commits, marked do-not-merge).
- The "31 PRs" in the table below counts merges after #211 (integration → `main`, 09:55 IST). #205–#209 and #212–#215 also merged into integration early on 27 Oct IST (01:57–03:50) and reached `main` through #211.

## Status at ~21:30 IST

> `integration/phase-1` (head `4f197bb`) was merged into `main` by Shubham via [#247](https://github.com/iakash22/meetops-platform/pull/247) (merge commit `47dbf97`, 21:19 IST). Everything below is **on `main`**. Percentages are coordinator estimates, not measured.

| Phase                           | 27 Oct AM | 27 Oct PM | Merged today (27 Oct)                                                                                                                                                                                                |
| ------------------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Foundation                   | 100%      | 100%      | —                                                                                                                                                                                                                    |
| P1 Auth, orgs, roles            | ~90%      | ~90%      | #221 (strict CORS allowlist)                                                                                                                                                                                         |
| P2 Meetings, uploads, recording | ~62%      | ~75%      | #242 (readiness probes), #227                                                                                                                                                                                        |
| P3 Transcripts, reports         | ~35%      | ~65%      | #228, #229, #235, #236, #243                                                                                                                                                                                         |
| P4 Tasks, approval              | ~30%      | ~70%      | #222, #224, #225, #230, #232, #233, #234                                                                                                                                                                             |
| P5 GitHub, Jira                 | ~30%      | ~65%      | #223, #226, #231                                                                                                                                                                                                     |
| P6 Extension                    | ~45%      | ~70%      | #216, #217, #238, #239, #244, #245                                                                                                                                                                                   |
| P7 Calendar, search, analytics  | 5%        | 5%        | —                                                                                                                                                                                                                    |
| P8 Desktop, mobile              | ~45%      | ~55%      | #218, #219, #220, #237, #240, #241                                                                                                                                                                                   |
| P9 Hardening, release           | ~15%      | ~25%      | #246 (token-gated /metrics), #243                                                                                                                                                                                    |
| **Overall**                     |           | **~60%**  | 31 PRs: #216, #217, #218, #219, #220, #221, #222, #223, #224, #225, #226, #227, #228, #229, #230, #231, #232, #233, #234, #235, #236, #237, #238, #239, #240, #241, #242, #243, #244, #245, #246, then #247 → `main` |

Notes:

- #241 desktop auth: desktop tokens are accepted only when `DESKTOP_AUTH_ENABLED` is on (default **off**). The extension guard still accepts extension tokens only.
- On hold: `feat/worker-ai-queue-consumer` (`4dc75a7`, no PR) — needs `GEMINI_API_KEY`.
- GitHub Actions runs fail; the local merge gate (build, lint, typecheck, test, gitleaks, Arch/Sec PASS on head) is the CI.
- Both agents are idle until Shubham says "start work".

## Owner decisions (Shubham)

- ADR drafts #192, #193, #199 and Proposed ADRs 006–013 sign-off.
- Dependabot lockfile update (9 alerts).
- Bearer routes: accept token or cookie?
- MFA/SSO, billing, KMS, malware scanning, media retention, consent law.
- Keys via secure input: Gemini, AssemblyAI, Gmail SMTP.
- GitHub Actions failures.

---

## Earlier status (27 Oct ~01:30 IST)

> All code below is merged into `integration/phase-1`, **not yet on `main`**. Percentages are coordinator estimates from merged work, not measured.

| Phase                           | 25 Oct | 27 Oct | Merged (integration)                                                         | Open PRs               | Missing                                                                                                         |
| ------------------------------- | ------ | ------ | ---------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| P0 Foundation                   | 100%   | 100%   | —                                                                            | —                      | Nothing                                                                                                         |
| P1 Auth, orgs, roles            | 85%    | ~90%   | #149, #140, #188, #195, #201                                                 | #205, #208             | Notification prefs + unsubscribe routes (signing secret, user timezone); MFA/SSO decision; ADR-006/010 sign-off |
| P2 Meetings, uploads, recording | 45%    | ~62%   | #164, #166, #167, #168, #169, #177, #179, #181, #202                         | #196, #197, #206       | Upload checksum verification on complete; live-DB tests                                                         |
| P3 Transcripts, reports         | 30%    | ~35%   | #172 (web views)                                                             | — (p3 branch unpushed) | Transcript/report API                                                                                           |
| P4 Tasks, approval              | 20%    | ~30%   | #174 (review UI)                                                             | #203                   | Task API                                                                                                        |
| P5 GitHub, Jira                 | 25%    | ~30%   | #183 (settings on mocks)                                                     | #204, #207             | Sync engine; real connections                                                                                   |
| P6 Extension                    | 35%    | ~45%   | #145, #159, #185, #191                                                       | #209, #200, #199       | Extension auth live, revocation enforced (#216); bearer routes and CORS in review; direct upload flagged off    |
| P7 Calendar, search, analytics  | 5%     | 5%     | —                                                                            | —                      | Not started                                                                                                     |
| P8 Desktop, mobile              | 20%    | ~45%   | #138, #146, #161, #176, #180, #187, #141, #148, #170, #171, #173, #184, #186 | #192, #193             | Real mobile recording; real app ids                                                                             |
| P9 Hardening, release           | 15%    | ~15%   | #133, #194, #198                                                             | —                      | Billing, monitoring, Dependabot (9 alerts), 3 medium security fixes                                             |

## Next (resume 27 Oct)

1. #202 — merged (verify downstream rebases).
2. All Rounder merges integration into #196, #197 and #205.
3. p3 branch `207ae20`: full CI, then push/PR.
4. #204: DELETE revoke + soft-disconnect fix (`fd35bf0`).
5. ar-sec security fixes: token revocation, realtime re-auth + connect rate limit, upload checksum.
6. #209, then #200.
7. Open the integration/phase-1 → main PR.

## Owner decisions (Shubham)

- ADR drafts #192, #193, #199; ADR-006, ADR-010, ADR-011, ADR-012 sign-off.
- MFA / SSO scope.
- Real app ids and domain.
- Dependabot fix (pnpm overrides, lockfile change).
- Note: live Postgres/Redis tests have not run on the coordinator box (no Docker); All Rounder runs them locally.

---

## Previous status (25 Oct)

# MeetOps AI — Phase status

> Snapshot: 2026-10-25, local `main` at `b074922` (merge of pull request #157 from `integration/phase-1`, 18:12 IST). Read from the tree on that commit. No secrets. Open pull requests on GitHub were not re-listed.
>
> Older notes understate this branch: `README.md` still says the repo is in Phase 0, `docs/17-agents/implementation-board.md` stops at 2026-10-22, and `docs/AGENT_STATUS.md` / `docs/PROJECT_CONTEXT.md` freeze at 2026-10-24 ~15:25 IST. Use this file for phase status.

Pre-alpha. Phase 0 is done. Phase 1 is nearly done. Phases 2–6 and 8 are started and unfinished. Phases 7 and 9 have not started.

The first milestone is create organization → add employee → create project → upload audio → transcribe → generate report → extract and approve tasks → create a GitHub or Jira issue → sync status. The API serves the directory. It does not yet serve meetings, uploads, transcription, task approval, or GitHub/Jira.

"Scope present" is a reading of how much of that phase's README scope is in this checkout. It is not a measured metric and not an official score.

| Phase | Status          | Scope present | On `main`                                                                                                                                    | Still open                                                                               |
| ----- | --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0     | Done            | 100%          | pnpm, Turborepo, apps (api, web, worker, realtime, extension, desktop, mobile), packages, Compose, CI                                        | README still says the repo is in Phase 0                                                 |
| 1     | Nearly done     | 85%           | Signup through sessions, organizations, invitations, members, employees, teams, projects, CASL, RLS, contracts 0.4.0, web auth and directory | Default mail transport drops messages. MFA and SSO are undecided                         |
| 2     | In progress     | 45%           | Meeting and file models, upload and recording-session contracts, media worker, storage package, meetings UI                                  | No meetings, upload, or recording-session routes. Realtime rejects every handshake       |
| 3     | In progress     | 30%           | Transcript tables, `ai-core` adapters and extraction pipeline, transcription consumer                                                        | Worker stays unregistered. No transcript, report, or extraction API                      |
| 4     | Early           | 20%           | Task and approval tables, task list contract, web tasks page, email package                                                                  | No task or approval API. Task mail is not a product flow                                 |
| 5     | Library only    | 25%           | GitHub and Jira adapters, OAuth, webhook replay, token encryption in `packages/integrations`                                                 | API and worker never call that package                                                   |
| 6     | Capture started | 35%           | WXT extension (pairing UI, recorder, chunk store) and the web pair page                                                                      | No extension auth routes. HTTP upload is off. Live speech-to-text is deferred            |
| 7     | Pending         | 5%            | `pgvector` column on transcript segments                                                                                                     | No calendar, Meet/Zoom/Teams import, search, automation, or analytics                    |
| 8     | Scaffolds       | 20%           | Tauri shell with mock sign-in. Expo app through signup and tabs, demo mode                                                                   | No offline recording. ADR-012 unsigned. Placeholder bundle ids. Mobile M3–M6 not started |
| 9     | Pending         | 15%           | CI workflows, Dockerfiles, threat model, security tests                                                                                      | No billing, production monitoring product, or release                                    |

## Phase 0 — Done

Monorepo foundation: tooling, apps, shared packages, Docker Compose, logging, and basic CI. Pull requests #1 and #2 merged to `main`.

## Phase 1 — Nearly done

Auth, organizations, employees, teams, projects, and RBAC.

In the API (`apps/api` `registerModules`): signup, login, forgot and reset password, email verification, sessions, organizations, invitations, members, and the directory (employees, teams, team members, projects) with CASL. The web directory uses the real client unless `VITE_DIRECTORY_MOCKS=true`. Contracts are at 0.4.0. Postgres uses forced row-level security. The tenant key in schema and routes is `organizationId`.

Still open:

| Item                 | State                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound email       | `InlineAuthMailQueue` runs in the API process. The default transport is an empty `send`. The production BullMQ adapter is still a TODO in `apps/api/src/modules/auth/application/auth-mail.handler.ts`. `startEmailWorker` exists in `packages/notifications` and is not what `apps/worker` starts. |
| MFA, SSO, guest role | Open questions in `docs/12-security/assumptions-open-questions.md`. No implementation.                                                                                                                                                                                                              |
| Lockout and sessions | Redis lockout and opaque session tokens exist. [ADR-006](15-decisions/ADR-006-login-lockout-one-time-tokens.md) is still Proposed. Idle versus absolute timeout is an open product question.                                                                                                        |
| Tenant key           | `organizationId` is what the schema and APIs use. [ADR-010](15-decisions/ADR-010-organization-id-tenant-key.md) is still marked Proposed.                                                                                                                                                           |

## Phase 2 — In progress

Meetings, uploads, browser recording, and the FFmpeg pipeline.

Present: Prisma models for meetings, recordings, file objects, and recording-session chunks; upload and recording-session contracts; the media worker (probe, normalize to WAV, waveform, chunking, organization-scoped storage); `packages/storage`; web meetings list, detail, and upload button.

Still open:

| Item                           | State                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meetings API                   | Models and web pages exist. `registerModules` does not mount meeting routes.                                                                                                                                                     |
| Uploads and recording sessions | Contracts and the extension HTTP client exist. The API does not expose `POST /orgs/:organizationId/uploads` or the recording-session routes. The extension build defaults to `StubUploadClient` (`WXT_FEATURE_HTTP_UPLOAD` off). |
| Realtime                       | Socket.IO server, organization and meeting rooms, upload and processing events. The production entry uses `denyAllVerifier`. [ADR-011](15-decisions/ADR-011-realtime-auth.md) needs Architecture and Security sign-off.          |
| Meeting access                 | The API session verifier's meeting-access hook is fail-closed and unfinished.                                                                                                                                                    |
| Web calls                      | The meetings UI and upload button call routes the API does not serve, so those screens 404 against this API.                                                                                                                     |

## Phase 3 — In progress

Transcription, reports, decisions, and task drafts with evidence.

Present: transcript, segment, chunk, report, and extracted-task tables; AssemblyAI, faster-whisper, Gemini, Ollama, and OpenAI-compatible adapters; an extraction pipeline in `packages/ai-core`; a transcription consumer in `apps/worker`.

Still open:

| Item                 | State                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcription worker | The consumer is written. `apps/worker/src/index.ts` does not inject a repository, so the processor stays unregistered even when `TRANSCRIPTION_WORKER_ENABLED` is true.     |
| Summaries and drafts | The extraction pipeline, prompts, and schemas live in `packages/ai-core`. No API writes `Report` or `ExtractedTask`.                                                        |
| Providers            | A Deepgram adapter file remains in `packages/ai-core`. The product decision is AssemblyAI by default, optional faster-whisper, no Deepgram, and no automatic paid fallback. |

## Phase 4 — Early

Task review, approval, assignment, and notifications.

Present: `Task` and `TaskApproval` models, the task list contract, and a web tasks page that calls `GET /orgs/:organizationId/tasks`. The notifications package can send SMTP or console email.

Still open: no task module in the API, no review or assign flow, and no task-notification product path. `apps/worker` does not start an email consumer.

## Phase 5 — Library only

GitHub and Jira with two-way sync.

`packages/integrations` has issue create and update, retries, a webhook delivery store, PKCE OAuth, and token encryption. Nothing in `apps/api` or `apps/worker` imports that product flow. There is no install UI and no sync worker. [ADR-007](15-decisions/ADR-007-integrations-retry-webhook-replay.md) and [ADR-008](15-decisions/ADR-008-oauth-pkce-token-encryption.md) are Proposed.

## Phase 6 — Capture started

Live transcription and the browser extension.

The extension (WXT, Manifest V3) has pairing UI, a recorder, and a chunk store. The web app has `/extension/pair`. [ADR-005](15-decisions/ADR-005-extension-auth.md) is accepted. `apps/api` serves the extension pair, token, refresh and revoke routes (`extension-auth` module); revoked tokens are rejected (#216). Bearer-authenticated API routes and extension-origin CORS are in review (`feat/api-extension-bearer-routes`, `feat/api-extension-bearer-cors`). The extension consent registry has no consent API (user, time, meeting, `organizationId`). Live speech-to-text is deferred; background AssemblyAI is the chosen path.

## Phase 7 — Pending

Calendar, Meet/Zoom/Teams imports, search, automation, and analytics are not started. `transcript_segments.embedding` is `vector(1536)` in the initial migration. Nothing writes or queries it.

## Phase 8 — Scaffolds

Desktop and mobile offline recording.

| App                      | State                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop (`apps/desktop`) | Tauri 2 M1 scaffold. Mock sign-in and sign-up, sample meetings, one read-only Rust `app_info` command. Bundle id is still `ai.meetops.desktop.todo-owner`. [ADR-012](15-decisions/ADR-012-desktop-auth.md) is Proposed and needs Architecture and Security sign-off. No recording.                                                                                          |
| Mobile (`apps/mobile`)   | Expo SDK 52. M1 scaffold and M2 demo auth, signup, organization switcher, and tabs (Meetings, Record, Tasks, Account). `IS_DEMO_MODE` is true. Tokens stay in memory. Meetings, tasks, and the upload queue are placeholders. The Record tab is a UI shell. M3 consent through M6 release are not started. Bundle id is `com.example.meetops`. Plan: `docs/mobile/plan.md`. |

## Phase 9 — Pending

Production hardening, billing, monitoring, and release are not started. CI workflows, Dockerfiles, the threat model, and security tests exist. The marketing site (`apps/marketing`, TanStack Start) is named in the README and is not in the repo. Secret manager, malware scanning, media retention, and consent-by-jurisdiction are open questions.

## Gaps that cut across phases

1. **Contract without a route.** Meetings, uploads, recording sessions, tasks, and extension auth are in `@meetops/contracts` 0.4.0. `registerModules` only mounts auth, organizations, and the directory.
2. **Jobs that do not run.** The media worker can start. Transcription will not, because no repository is injected. Email and integration queues have packages and no process in `apps/worker`.
3. **Three clients, one real session.** Web cookies are real. The extension bearer flow is served (pairing, rotation, revocation); bearer access to the wider API is in review. The desktop PKCE flow is specified and not served. Mobile is hard-coded to demo mode.
4. **Boards lag the branch.** The implementation board, agent status, project context, and `docs/12-security/assumptions-open-questions.md` still describe Phase 0 or 22–24 Oct. CASL is a dependency and is used for organizations and the directory; the assumptions note still says it is not.

## Decisions still marked open

| Decision                                                                                                                             | Doc status     | Code on this commit                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------- |
| [ADR-005](15-decisions/ADR-005-extension-auth.md) extension auth                                                                     | Accepted       | Client built. Auth routes served; bearer routes in review |
| [ADR-011](15-decisions/ADR-011-realtime-auth.md) realtime auth                                                                       | Proposed       | Server fail-closed                                        |
| [ADR-012](15-decisions/ADR-012-desktop-auth.md) desktop sign-in                                                                      | Proposed       | Mock client only                                          |
| [ADR-006](15-decisions/ADR-006-login-lockout-one-time-tokens.md) lockout and one-time tokens                                         | Proposed       | Implemented in the API                                    |
| [ADR-007](15-decisions/ADR-007-integrations-retry-webhook-replay.md), [ADR-008](15-decisions/ADR-008-oauth-pkce-token-encryption.md) | Proposed       | Package only                                              |
| [ADR-009](15-decisions/ADR-009-ai-provider-routing-credentials-ssrf.md) AI routing and SSRF                                          | Proposed       | Guards exist in `ai-core`                                 |
| [ADR-010](15-decisions/ADR-010-organization-id-tenant-key.md) `organizationId`                                                       | Proposed       | Used as the tenant key                                    |
| KMS, malware scan, retention, consent law, MFA                                                                                       | Open questions | No product choice in code                                 |

## Next slice

Serve meetings, presigned uploads, and recording sessions from the API, point the extension HTTP client at them, then inject the transcription repository so the worker already in the repo can consume the queue. Task approval and GitHub or Jira stay behind that.
