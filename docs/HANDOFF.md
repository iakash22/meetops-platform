# MeetOps — handoff for a new agent

Written 31 Oct 2026 (IST). Read this first; it assumes no prior context. Owner: **Akash** (GitHub `iakash22`).

## Update — 11 Nov 2026 (~23:45 IST, Asia/Calcutta)

Native Apps reviewed merged [#447](https://github.com/iakash22/meetops-platform/pull/447) and implemented
the missing activity-id contract on `feat/mobile-live-activity-id` (local work based on
`origin/integration/phase-1` `de8a86e4`). JS stores the id returned by native `start` and passes it to
`update`/`end`. A refused or empty start is fail-closed. Swift `Activity.request` now resolves with
`activity.id` (not compiled: no Xcode on the box). Android `RecordingServiceModule.start` returns the
existing `#318` `captureId` for `update`/`stop`; the start/stop handshake is unchanged. Xcode and
device steps: [docs/mobile/live-activity.md](mobile/live-activity.md).

## Update — 9 Nov 2026 (~22:35 IST)

`main` is at `ca3c0e2b` (unchanged). `integration/phase-1` is at `fd4ede49` (55 ahead / 0 behind `main`), the merge of [#459](https://github.com/iakash22/meetops-platform/pull/459) Google OIDC hardening (Architecture + Tester PASS on `c41fc720`). Also merged 9 Nov into integration: [#457](https://github.com/iakash22/meetops-platform/pull/457) TRUST_PROXY docs; [#458](https://github.com/iakash22/meetops-platform/pull/458) Dependabot `serde_with` + glib RE-07 (Tester); [#460](https://github.com/iakash22/meetops-platform/pull/460) `plist`/`quick-xml` RUSTSEC clear (Tester). Current phase percentages are in [PHASE_STATUS.md](PHASE_STATUS.md). The percentages in §2 below are the 31 Oct snapshot.

Google **login** code is in and hardened (#459). It stays hidden until `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` are set together. Google **Calendar** still needs its own client (`GOOGLE_CALENDAR_*`). MFA and enterprise SSO are not built (ADR-021 plan + pending suite in #456). Small #459 follow-ups remain (in-memory store race X4-mem, post-commit verify UX, log redaction nits). Owner decision OD-1: cross-device email verify still drops the password until Akash decides otherwise.

Dependabot remaining-work #2 is **partial** (#458 + #460); glib/deepmerge stay accepted exceptions; Dependabot alerts read on the agent token is still needs-owner.

## Update — 9 Nov 2026 (~20:45 IST)

`main` is at `ca3c0e2b` (unchanged). Google OIDC sign-in landed as `f6c77fd855` on `dev`, merged via `34c0d247`, with docs `ca3c0e2b`. `integration/phase-1` is at `741ec449` (merges of [#454](https://github.com/iakash22/meetops-platform/pull/454) status docs, [#455](https://github.com/iakash22/meetops-platform/pull/455) realtime TRUST_PROXY, [#456](https://github.com/iakash22/meetops-platform/pull/456) ADR-021 MFA test plan; 15 ahead / 0 behind `main`). Current phase percentages are in [PHASE_STATUS.md](PHASE_STATUS.md). The percentages in §2 below are the 31 Oct snapshot.

Google **login** code is in. It stays hidden until `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` are set together. Google **Calendar** still needs its own client (`GOOGLE_CALENDAR_*`). MFA and enterprise SSO are not built (ADR-021 plan + pending suite in #456). Hardening follow-up is assigned on `feat/security/google-oidc-hardening` (not open as a PR yet): findings **M-2**, **N-1…N-6**, **L-1…L-5** (L-2/L-3 Info).

## 1. Repo and branches

- Repo: `iakash22/meetops-platform` (pnpm + turbo monorepo: `apps/api`, `apps/web`, `apps/worker`, `apps/extension` (wxt), desktop (Tauri/Rust), mobile (Expo/React Native), `packages/*` incl. `contracts`, `integrations`, `notifications`, `storage`).
- Work branch: **`integration/phase-1`** at `fd4ede49` (55 ahead / 0 behind `main`). All feature PRs target it.
- `main` at `ca3c0e2b2b74` (unchanged): only Akash merges into `main`. Recent merges (6 Nov IST): #437, #439, #443, #445, #447, #449, #450, #451, then #452 (`integration/phase-1` → `main`). After #452 Akash pushed Google OIDC sign-in (`f6c77fd855` on `dev`, merge `34c0d247`, docs `ca3c0e2b`).
- Merged into `integration/phase-1` (9 Nov): [#453](https://github.com/iakash22/meetops-platform/pull/453) rate-limit coverage; [#454](https://github.com/iakash22/meetops-platform/pull/454) status docs; [#455](https://github.com/iakash22/meetops-platform/pull/455) realtime TRUST_PROXY; [#456](https://github.com/iakash22/meetops-platform/pull/456) ADR-021 MFA test plan; [#457](https://github.com/iakash22/meetops-platform/pull/457) TRUST_PROXY docs; [#458](https://github.com/iakash22/meetops-platform/pull/458) Dependabot `serde_with`; [#460](https://github.com/iakash22/meetops-platform/pull/460) `plist`/`quick-xml`; [#459](https://github.com/iakash22/meetops-platform/pull/459) Google OIDC hardening. Tip `fd4ede49`.
- Open: [#462](https://github.com/iakash22/meetops-platform/pull/462) promotes `integration/phase-1` → `main` (Akash merges; not merged yet). Small #459 code follow-ups next into integration.
- Other docs: [PHASE_STATUS.md](PHASE_STATUS.md), [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md), [AGENT_STATUS.md](AGENT_STATUS.md), [local-gates.md](local-gates.md), ADRs in [15-decisions/](15-decisions/).

## 2. Project state (estimates, see PHASE_STATUS.md)

P0 100% · P1 ~95% · P2 ~85% · P3 ~70% · P4 ~75% · P5 ~80% · P6 ~85% · P7 ~45% · P8 ~75% · P9 ~35% · **overall ~72%**.

Merged 31 Oct (#305–#317): extension real meeting API + held recordings (#305, #307, #308); auth mail queue (#306); GitHub App E2E (#309, #313); mobile M3–M6 (#310–#312); P7 calendar, search, web, follow-ups (#314–#317). The handoff PR also fixes #317 L-1 / Info 2 / Info 3 (calendar refresh scope handling, re-encrypt guards).

## 3. Team rules (non-negotiable)

- No Cursor and no Slack for project work.
- GitHub Actions minutes are exhausted: **all gates run locally** — build, lint, typecheck, test, gitleaks — and the results are pasted into every PR.
- A merge needs a **Tester & Security PASS on the exact head SHA**. Merge with `gh pr merge --match-head-commit <sha>`.
- No force-push, no rebase, no `--no-verify`; git hooks stay on. Regular commits only.
- Never print or commit secrets (use placeholders in tests; `gitleaks detect --redact` must be clean).
- Only Akash merges into `main`.
- Email: Mailpit in dev, Gmail SMTP opt-in, Resend in production. **Never fall back from one provider to another.**
- No covert recording: capture is always visible and consented.

## 4. Box environment notes

- `export COREPACK_HOME=/tmp/corepack` before pnpm.
- inotify is exhausted by a host process (ENOSPC). The wxt watcher fix is in #313. Warm the cache with `pnpm lint --concurrency=1`.
- Docker is the static 27.3.1 build in `/usr/local/bin`. Start `dockerd --iptables=false --ip6tables=false` and run containers with `--network host`.
- DNS is fake-IP and the apt mirror is unreachable: do not rely on `apt install`.
- Shared box: check `pgrep -af 'pnpm|tsc|turbo'` and run one heavy job at a time. Prefer scoped gates (`pnpm --filter <pkg> ...`) when usage is tight.

## 5. Blocked on Akash

1. Google Calendar OAuth client (`GOOGLE_CALENDAR_*`). Web login OAuth is implemented and uses `GOOGLE_OAUTH_*`, a different client.
2. Install the `meetops-dev` GitHub App on a throwaway repo for E2E.
3. Gemini API key for P3.
4. Real bundle ids (replace `ai.meetops.desktop.todo-owner`, `com.example.meetops`).
5. Expo / React Native upgrade decision.
6. Dependabot read permission on the token.
7. ADR sign-offs: 006, 010, 011, 012, 013.
8. Windows `pnpm test` and `cargo check`.
9. Jira credentials.

## 6. Next tasks (priority order)

1. **Native mobile** (blocks store submission). Status 31 Oct:
   - Android microphone foreground service: **#318** (Kotlin service + module; the background pause lifts only when the service and its notification are confirmed).
   - Encryption at rest: **#320** (Android Keystore + iOS Keychain/CryptoKit AES-256-GCM, fail closed, legacy plaintext re-seal).
   - iOS backup exclusion + file protection: **#321** (Swift, fail closed).
   - iOS Live Activity / Dynamic Island: **not started**.
   - **None of the native code has been compiled** (the box has no Android SDK or Xcode). Each PR has a device-build checklist. `#318`, `#320` and `#321` each edit `src/services.ts`, so merge them one at a time and re-run mobile jest.
   - Still open on Akash: the real bundle id (still `com.example.meetops`), the Expo/RN upgrade decision, and EAS credentials.
2. **P7**: calendar background sync job, Outlook adapter, linking calendar events to meetings, pgvector semantic search.
3. **#313 follow-ups**: prettier on `github-app.e2e.test.ts`, segment-only E2E name matching, env PEM opt-in, check the selected repos.
4. ~~**Extension Info items**~~: addressed by merged #411 (fail-closed Start, durable pending, separate limits) and merged #437 (required Start checks, Start counts unheld pending chunks, server ceiling is contracts `MAX_CHUNK_BYTES` 64 MiB, local chunk/reserve stays 8 MiB).
5. ~~**Desktop**~~: done in 02561e2efdf4a202d702dc7a87f5eda320c28911 (`chunk_put` takes a raw IPC body with the slot in an `x-meetops-chunk` header, JSON refused; `chunk_get` returns raw bytes; legacy chunk folders migrated).
6. ~~**Mobile Lows**~~: done in #322 (server meeting id via `meetings/resolve` with `source: 'upload'`; wipe retries and surfaces failed deletes). Follow-up for Arch: a `mobile` `MeetingSource`.

## 7. How to resume (checklist)

- [ ] `git fetch origin && git switch -c <topic> origin/integration/phase-1`; read PHASE_STATUS.md and this file.
- [ ] `gh pr list --state open` — check open PRs and review state.
- [ ] Set `COREPACK_HOME=/tmp/corepack`; `pnpm install --frozen-lockfile`.
- [ ] Warm cache: `pnpm lint --concurrency=1`.
- [ ] If DB/Redis/MinIO/Mailpit needed: start dockerd (flags above), then `scripts/dev-services.sh up`.
- [ ] Pick the top unblocked task from §6; commit normally with hooks on.
- [ ] Run gates locally (`pnpm local-gates`, or scoped build/lint/typecheck/test + `gitleaks detect --redact`); paste results in the PR.
- [ ] Open the PR against `integration/phase-1`; get Tester & Security PASS on the exact head; merge with `--match-head-commit`.
- [ ] Update PHASE_STATUS.md when phases move.

## Update — 2026-10-31 14:30 IST (final stop at 99% usage)

Correction: #305–#307 merged on 2026-10-29, not Oct 31.

Merged into integration/phase-1 after the earlier handoff (head a6c20cf):

- #322 mobile Lows (a8029b7)
- #323 GitHub App e2e follow-ups (7bf0b88)
- #321 iOS backup exclusion + file protection, Swift module (edb6593)
- #318 Android foreground service, Kotlin (1f6a2b7)
- #320 encryption at rest: Android Keystore / iOS CryptoKit+Keychain, fail-closed, migration of old chunks (a6c20cf)

Native Kotlin/Swift was reviewed statically only. It has never been compiled or run on a device; use the device-build checklists in the #318/#320/#321 PR bodies.

Open, pushed, NOT yet reviewed by Tester (start here):

- #324 P7 calendar background sync, head 3268a955 (r1 Medium and Lows fixed; needs re-review)
- #325 #323 Lows follow-up, head 93a59023

Open mobile follow-ups (Tester r4 Mediums/Lows, not fixed):

1. Start-failure race: stop() is a no-op until the service is up, so a quick Start failure leaves the "recording" notification showing (RecordingServiceModule.kt:36-40). Status: pending-start cancel added in #328; the remaining stop()/onStartCommand check-then-act window is closed by an atomic handshake (`requestStop` / `markRunningUnlessCancelled`) in fix/mobile-start-failure-notification. Kotlin still static-review only: device-check a Start that fails within ~100 ms.
2. The launch cache sweep isn't awaited (services.ts:113) and could delete a live .m4a; make Start await it, and scope it to Audio/ and ExpoAudio/ only. Status: fixed in #328 (begin awaits the memoized recoverOnLaunch; sweep scoped by RECORDER_DIRS in src/record/recorderFiles.ts; tests "begin waits for the launch sweep…" and "sweeps leftover recorder files…" in **tests**/native-capture.test.ts).
3. R5: the whole recording sits in plaintext in the app cache until Stop. The real fix needs the server to allow audio/aac or join segments server-side.
4. Encryption runs on the JS thread and is slow for large files; killing the app mid-encrypt deletes the recording.
5. Stopping after the app is swiped away depends on JS; the Open action falls back to an empty Intent.

Remaining Akash inputs are unchanged (see above). Agents' local WIP was asked to be pushed to its own branches at stop time.
