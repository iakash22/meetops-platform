# Phase status — 11 Nov 2026 (~23:30 IST)

## Update — 11 Nov 2026 (~23:30 IST)

Tree: `main` at `ca3c0e2b` (unchanged). `integration/phase-1` at `de8a86e4` (includes the #463 merge `6feef782`, then #464, #465, #461, and Dependabot #466/#467).

[#463](https://github.com/iakash22/meetops-platform/pull/463) closed the remaining #459 follow-ups: Tester X4-mem (in-memory store copies), NB-R3 post-commit verify UX (verify returns 204 with the real `x-meetops-verify-outcome` after a committed takeover), and the info copy (`password_reset` vs `set_password` on `/verify-email`).

# Phase status — 9 Nov 2026 (~22:35 IST)

## Update — 9 Nov 2026 (~22:35 IST)

Tree: `main` at `ca3c0e2b` (unchanged). `integration/phase-1` at `fd4ede49` (55 ahead / 0 behind `main`), merge of [#459](https://github.com/iakash22/meetops-platform/pull/459) Google OIDC hardening (Architecture + Tester PASS on `c41fc720`).

Also merged 9 Nov into integration after the ~20:45 snapshot: [#457](https://github.com/iakash22/meetops-platform/pull/457) TRUST_PROXY env/docs share; [#458](https://github.com/iakash22/meetops-platform/pull/458) Dependabot `serde_with` 3.17→3.21 + glib RE-07 (Tester; remaining-work #2 **partial**); [#460](https://github.com/iakash22/meetops-platform/pull/460) `plist`/`quick-xml` clearing RUSTSEC-2026-0194/0195 (Tester).

**Deploy note (#455, unchanged):** production realtime must set `TRUST_PROXY` to an IP/CIDR allowlist including nginx; hop counts fail startup. Compose passes `BEHIND_CLOUDFLARE` only to the realtime service (API still reads the env var in code — see [environment-variables.md](00-getting-started/environment-variables.md) and [cicd.md](devops/cicd.md#deploy-env-realtime-trust_proxy-after-455)).

Google OIDC hardening findings M-2, N-1…N-6, L-1…L-5 are **closed in #459**. The #459 follow-ups (Tester X4-mem on the in-memory store, NB-R3 verify/post-commit UX, info copy) are **closed in [#463](https://github.com/iakash22/meetops-platform/pull/463)**. MFA/SSO product work remains future (ADR-021); #456 is the test plan only. Owner decision OD-1 (cross-device verify drops password) stays with Akash.

P1 estimate ~98% (Google web sign-in + hardening in; MFA/SSO still open). P9 Dependabot row #2 partial.

## Update — 9 Nov 2026 (~20:45 IST)

Tree: `main` at `ca3c0e2b` (unchanged). `integration/phase-1` at `741ec449` (15 ahead / 0 behind `main`). Merged since the 20:30 snapshot: [#454](https://github.com/iakash22/meetops-platform/pull/454) status docs; [#455](https://github.com/iakash22/meetops-platform/pull/455) realtime client IP uses the shared API `TRUST_PROXY` allowlist (`REALTIME_TRUST_PROXY_HOPS` removed); [#456](https://github.com/iakash22/meetops-platform/pull/456) ADR-021 MFA test plan + pending security suite.

**Deploy note (#455):** production realtime must set `TRUST_PROXY` to an IP/CIDR allowlist including nginx; hop counts fail startup. See `.env.example`, [environment-variables.md](00-getting-started/environment-variables.md), and [cicd.md](devops/cicd.md#deploy-env-realtime-trust_proxy-after-455).

Google OIDC hardening on `feat/security/google-oidc-hardening` is still assigned (findings M-2, N-1…N-6, L-1…L-5; L-2/L-3 Info). MFA/SSO product work remains future (ADR-021); #456 is the test plan only.

## Update — 9 Nov 2026 (~20:30 IST)

Tree: `main` at `ca3c0e2b` (unchanged). `integration/phase-1` at `20aef486` (merge of [#453](https://github.com/iakash22/meetops-platform/pull/453); 6 ahead / 0 behind `main`). #453 brought rate-limit coverage (P9 #9 done) plus the OIDC-era lint/build/DB-test fixes.

**Google OIDC sign-in — shipped to `main`.** Feature commit `f6c77fd855` (via `dev` merge `34c0d247`, docs `ca3c0e2b`). Web-only authorization-code + PKCE; button stays hidden until `GOOGLE_OAUTH_*` are set together. Separate from `GOOGLE_CALENDAR_*`. Mobile and desktop do not offer Google sign-in. MFA and enterprise SSO remain future work (ADR-021).

**Hardening follow-up in progress** on `feat/security/google-oidc-hardening` (assigned to All Rounder Techy; not an open PR yet). Finding IDs: **M-2**; **N-1**, **N-2**, **N-3**, **N-4**, **N-5**, **N-6**; **L-1**, **L-2**, **L-3**, **L-4**, **L-5** (L-2 and L-3 are Info). Scope includes pre-registration takeover (N-1), verified-email / `hd` / auto-link rules (N-2, M-2), Google rate-limit ordering (N-3), audit/`auth_level` (N-4), JWKS single-flight + refresh fallback (N-5), optional iat/state/body caps (N-6), soft-delete `google_sub` uniqueness (L-1), `azp` when `aud` is multi-valued (L-2 Info), JWKS refresh throttle (L-3 Info), separate HMAC key for the state cookie via HKDF (L-4), and the missing failure-path tests (L-5). Password policy values stay 8–128 with composition rules (Akash, 9 Nov).

P1 estimate stays ~97% (Google web sign-in in; MFA/SSO and OIDC hardening still open). Other phase percentages unchanged from the 7 Nov snapshot below.

## Update — 7 Nov 2026 (~00:45 IST)

Tree: `main` at `34c0d247` (merge of `dev`, 00:43 IST, 7 Nov). This snapshot is the local `main` tip. Open pull requests were not re-queried.

Landed in that merge (`f6c77fd8` on `dev`):

- **Web Google sign-in** (ADR-021 item 3, web only). Authorization code + PKCE. The API exchanges the code and checks the ID token (audience, nonce, `email_verified`). No Google refresh token is stored. Routes: `GET /auth/providers`, `GET /auth/google/start`, `GET /auth/google/callback`. The button stays hidden until `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` are set together. That client is separate from `GOOGLE_CALENDAR_*`. Mobile and desktop do not offer Google sign-in.
- **Linking.** Match `users.google_sub` first (`20261106120000_user_google_sub`). A verified local account with no Google subject is linked. An unverified local email is refused. A new Google user is created with the email already verified and no usable password.
- **Password policy.** Signup and reset require 8–128 characters with a letter, a number, and a symbol. The rule lives in `@meetops/contracts` and is enforced by the API and by web, mobile, and desktop signup. Login still accepts any non-empty password up to 128 characters.

| Phase                          | 4 Nov | 7 Nov | Remaining                                                                                                       |
| ------------------------------ | ----- | ----- | --------------------------------------------------------------------------------------------------------------- |
| P0 Foundation                  | 100%  | 100%  | —                                                                                                               |
| P1 Auth, orgs, RBAC            | ~95%  | ~97%  | MFA (TOTP/WebAuthn) and enterprise SSO. Google web sign-in is in; turn it on with `GOOGLE_OAUTH_*`              |
| P2 Capture, uploads, consent   | ~92%  | ~92%  | Extension Info items                                                                                            |
| P3 Transcription, AI           | ~85%  | ~85%  | Gemini key (owner), real-provider E2E                                                                           |
| P4 Tasks, approval             | ~87%  | ~87%  | —                                                                                                               |
| P5 Integrations                | ~88%  | ~88%  | Jira creds, GitHub App install (owner)                                                                          |
| P6 Notifications               | ~87%  | ~87%  | Production email domain (owner)                                                                                 |
| P7 Calendar, search, analytics | ~85%  | ~85%  | Google Calendar OAuth client (`GOOGLE_CALENDAR_*`, owner). Login OAuth is a different client and is implemented |
| P8 Native desktop/mobile       | ~85%  | ~85%  | Never compiled; device checklists; bundle ids (owner)                                                           |
| P9 Hardening, release          | ~60%  | ~60%  | Alert routing (owner), SBOM, versioning, deploy target, backup drill, billing, KMS, store submission            |

Percentages are coordinator-style estimates, not measured. P2–P9 did not move in this snapshot; only P1 changed, for Google web sign-in and the shared password policy.

## Update — 4 Nov 2026 (~21:50 IST)

Tree: `integration/phase-1` at `1d46e8c6` (merge of #441, 21:42 IST, 4 Nov). PR states queried live from the GitHub
API at ~21:50 IST. Percentages below are re-estimated for this snapshot (coordinator-style estimates, not measured).

**#384 (`integration/phase-1` → `main`)**: open, head `1d46e8c6`, 296 commits, 379 files, +29,107/−1,884.
GitHub reports `mergeable_state: unstable` (no passing remote checks: Actions minutes are exhausted, so the local
gate is the gate). `main` has 3 commits not on integration (SelectField / invite-form UI). Only Akash merges #384.

Merged since the 04:20 snapshot (42 PRs):

- P3/AI: transcription retry + DLQ (#414), DLQ redrive (#420), `transcription_delayed` alert (#423), DLQ follow-ups
  (#433), STT no-fallback comment fix (#435), ADR-009 revision (#409).
- P5/integrations: refresh grace window (#421, #426, #428), webhook delivery store (#432, #434), DB org config store
  (#425, #429), extension fail-closed pending (#411), extension auth allowlist/revoke (#418).
- P7: semantic embeddings pipeline (#350), calendar background sync (#394) and auto-link (#398).
- P2/P4 media and consent: consent hardening (#387), upload chunk rate limits (#419), media rate-limit hardening
  (#424), storage quota fail-closed (#430).
- P8: iOS Live Activity hardening (#347, merged 21:24 IST).
- Realtime/web: realtime hardening (#417), web realtime client (#415, #422), web CSS budget (#441).
- P9: docs CSP in prod (#404), security checklist (#391), dependency overrides (#412), P9 hardening (#416), CD
  pipeline scaffold (#408) and deploy sentinel (#427), turbo test outputs (#413), coverage tooling (#431), pnpm
  overrides guard (#405), Tester Lows batch (#403).
- Docs/tests: architecture overview (#407), README DB setup (#406), email verification concurrency (#410), auth-UI
  test deflake (#438), web E2E smoke suite (#440).

**Open PRs** (base `integration/phase-1` unless noted), live at ~21:50 IST:

| PR   | What                                                                       |
| ---- | -------------------------------------------------------------------------- |
| #384 | `integration/phase-1` → `main` (base `main`; Akash merges)                 |
| #402 | This status snapshot, ops/observability docs, P9 #13 alert rules           |
| #436 | Worker: retry transcription delayed-status reads                           |
| #437 | Extension: fail-closed Start, unheld pending chunks, server chunk size     |
| #439 | API: audit extension delisting, keep families on an empty allowlist        |
| #442 | Database: `ai_org_config.updated_by_id` must be an org member              |
| #443 | Handoff docs: desktop `chunk_put` and extension Info items done            |
| #444 | Integrations: delivery-store doc nits, `REDIS_IT_URL` passthrough          |
| #445 | API: per-org search caps and a 503 timeout on search routes                |
| #446 | API: `POST /orgs/:organizationId/meetings` (New meeting 404 found by #440) |
| #447 | Mobile: Live Activity follow-ups                                           |
| #448 | Release: CycloneDX SBOM script, versioning and changelog (P9 #11/#12)      |
| #449 | Deploy: validated target-agnostic interface with `prisma migrate deploy`   |
| #450 | Ops: Postgres backup and local restore drill (P9 #10)                      |

#441 merged at 21:42 IST; #347 and #440 are merged and no longer open.

| Phase                          | 3 Nov | 4 Nov | Remaining                                                                                            |
| ------------------------------ | ----- | ----- | ---------------------------------------------------------------------------------------------------- |
| P0 Foundation                  | 100%  | 100%  | —                                                                                                    |
| P1 Auth, orgs, RBAC            | ~95%  | ~95%  | MFA/SSO policy (ADR-021)                                                                             |
| P2 Capture, uploads, consent   | ~90%  | ~92%  | Extension Info items                                                                                 |
| P3 Transcription, AI           | ~75%  | ~85%  | Gemini key (owner), real-provider E2E                                                                |
| P4 Tasks, approval             | ~85%  | ~87%  | —                                                                                                    |
| P5 Integrations                | ~85%  | ~88%  | Jira creds, GitHub App install (owner)                                                               |
| P6 Notifications               | ~85%  | ~87%  | Production email domain (owner)                                                                      |
| P7 Calendar, search, analytics | ~70%  | ~85%  | Google OAuth client (owner), follow-ups                                                              |
| P8 Native desktop/mobile       | ~85%  | ~85%  | Never compiled; device checklists; bundle ids (owner)                                                |
| P9 Hardening, release          | ~50%  | ~60%  | Alert routing (owner), SBOM, versioning, deploy target, backup drill, billing, KMS, store submission |

## Update — 3 Nov 2026 (~04:20 IST)

Tree: `integration/phase-1` at `190b9d5` (merge of #397, 03:47 IST). PR states read from the GitHub API at ~04:15 IST.

Merged since the 02:45 snapshot:

- #393 P9 security headers, CORP, CSP reporting, env validation; #399 its follow-ups (R4, R5, R7, R13, R14, R19, R20, R24).
- #400 credential-free test coverage for the analytics SQL and semantic search.
- #401 415 for non-JSON unsafe request bodies and CSRF token rotation (R16, R17).
- #385 calendar links deleted inside the revoke transaction; #386 task sync gated on one approval read; #392 analytics counts; #395 ajv/esbuild overrides; #396 Outlook tenant validated at startup; #397 the previous status refresh.

Still open: #387 (consent hardening), #394 (background sync) and #398 (auto-link, stacked on #394), all merged up to
`190b9d5`; #350 (embeddings pipeline, based on `085078f4`, does not contain `190b9d5`); #347 (iOS Live Activity, draft);
#391 (P9 docs); #384 (integration → `main`). Tester Lows are batched in #403 (#396, #398–#401) and #404 (production
`/docs` CSP and admin gate); #394's own findings are fixed on #394.

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

Checked against `gh pr list` / `gh pr view` and the tree at `integration/phase-1` `99a6f4f` and `main` `02646a1`. Phase percentages are coordinator estimates, not measured.

- Merged after the ~21:30 IST snapshot:
  - [#249](https://github.com/iakash22/meetops-platform/pull/249) (into `integration/phase-1`, 22:40 IST) and [#250](https://github.com/iakash22/meetops-platform/pull/250) (into `main`, 22:41 IST): notifications architecture plan and [ADR-013](15-decisions/ADR-013-notifications-architecture.md) (Proposed).
  - [#251](https://github.com/iakash22/meetops-platform/pull/251) (into `integration/phase-1`, 22:46 IST): the API now wires the real mailer (`EMAIL_PROVIDER=smtp|resend|console`) and `packages/notifications` gains a Resend provider. Production still needs the BullMQ mail queue.
  - [#252](https://github.com/iakash22/meetops-platform/pull/252) (22:42 IST) and [#253](https://github.com/iakash22/meetops-platform/pull/253) (22:48 IST): `integration/phase-1` → `main`. `main` now contains everything on `integration/phase-1` up to `99a6f4f`.
- `main` also carries docs merged directly into it (#248 status update, #250), which `integration/phase-1` did not have until this docs PR merged `main` back in.
- Open PRs (all drafts, base `integration/phase-1`): #192, #193, #199 (ADR amendment drafts, need owner sign-off) and #254, #255 (backup branches for unpushed desktop-native and mobile secure-store commits, marked do-not-merge).
- The "31 PRs" in the table below counts merges after #211 (integration → `main`, 09:55 IST). #205–#209 and #212–#215 also merged into integration early on 27 Oct IST (01:57–03:50) and reached `main` through #211.

## Status at ~21:30 IST

> `integration/phase-1` (head `4f197bb`) was merged into `main` by Akash via [#247](https://github.com/iakash22/meetops-platform/pull/247) (merge commit `47dbf97`, 21:19 IST). Everything below is **on `main`**. Percentages are coordinator estimates, not measured.

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
