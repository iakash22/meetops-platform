# MeetOps AI — Agent Work Status and Pending Work

> Snapshot: 2026-10-23 23:20 IST, from the coordinator's records and GitHub. **All work is STOPPED** (since 22:11 IST, a usage stop). Nothing below resumes until Akash restarts it in his own words. Read `docs/PROJECT_CONTEXT.md` first. No secrets.

Key: **Arch** = Architecture PASS, **Sec** = Security PASS, both on the exact head SHA. Integration = `integration/phase-1` (head `bb9806a`).

## Summary

| Agent | Current situation | Open PRs | Pending count |
|---|---|---|---|
| Architecture | Reviewer, stopped mid-queue | none | review queue (see below) |
| Security | Reviewer, stopped | none | review queue (see below) |
| Backend | #53 waiting on reviews | #53 | 1 PR + deferred items |
| Frontend | #48 merged; #61, #69 next | #61, #69 | 2 PRs |
| AI | #21 and #47 pushed and green | #21, #47 | 2 PRs |
| Integrations | Lockfile merges in progress at stop | #19, #36, #63, #67, #11 | 5 PRs |
| DevOps | Chores green except audit gate | #7, #26, #32, #33, #34, #40 | 6 PRs |
| QA | Both PRs green, waiting on reviews | #57, #68 | 2 PRs |
| Documentation | All findings fixed, re-review pending | #28, #31, #56, #58, #62, #64, #66 | 7 PRs |
| Native Apps | #55 and #60 merged | none | deferred LOW items |
| Database | Stopped, no open PR | none | P1-DB-4 WIP (uncommitted, unpushed) |
| Media/Realtime | Stopped, clone clean at aacc962 | none | none open |

## Per agent

### Architecture (reviewer)
- Done today: PASS on #48 (merged), #60 (merged), #47 (at 689ea5a), and #53 (at 214e4df).
- Pending reviews, in order:
  1. #61, #69
  2. The docs re-review: #28 f4a64be, #31 c62e828, #62 e63fd9e, #64 300a669, #66 02fa4d0, #58 5a0d041, and #56 after its board fix
  3. The DevOps chores: #26 583aef2, #34 6694598, #32 0aac47e, #40 eadfc94
  4. The #53 delta (214e4df to c23e7ca)
  5. The #47 delta (689ea5a to 3fdeaca, the port fix)
  6. #63, #67, #57, #68, #33, #7
- Note: the box is overloaded (load around 160), so run gates sequentially.

### Security (reviewer)
- Done today: PASS on #48, #60, #47 (689ea5a), #63 (3c0e8ac), #67 (d1585bc), #64, #66 and the earlier DevOps heads.
- Pending:
  - #53, which has no Security verdict yet
  - The docs re-review, with #62 the priority
  - Rechecks of #32 (SHA pins) and #34
  - #47 3fdeaca (the port fix)
  - #57, #68, #61, #69

### Backend — `apps/api`
- #53 (feat/api-persistence) is at head c23e7ca, with an integration merge and a 30s timeout added to the cold-import test. Arch PASS was at 214e4df, and the live Postgres and Redis run passed 8/8.
- Pending:
  - Arch delta check, Security verdict, green CI, then merge
- Deferred, not started:
  - Jira webhook freshness wiring (`requireTimestamp:true`)
  - Binding OAuth state to the browser session
  - Per-call scope check, loading connections by (orgId, integrationId)
  - Refresh-family revocation on token reuse (ADR-005)
  - Rename the `tenantId` key to `orgId` in stored AI configs, a data migration together with DB

### Frontend — `apps/web`
- #48 merged as ba37f12.
- Pending:
  - #61: retarget it to integration, merge integration in, get reviews, then merge.
  - #69: same process (it was stacked on #48).
- Deferred:
  - Architecture's nits: TaskUpdateEvent copied by hand, duplicated UUID regex, a flaky tasks.test.tsx
  - Tailwind 4 migration before 2026-11-20

### AI — `packages/ai-core`
- #21 is at 46db41a, with integration merged in and CI green. Its code is unchanged since the Arch and Sec passes at 8ba69b7.
- #47 is at 3fdeaca and includes the SEC-BUG-1 fix (remote endpoints must use port 443). It's stacked on #21.
- Pending:
  - Verify and merge #21.
  - Retarget #47, get both reviewers' delta check, then merge.
- Deferred:
  - Pin the local provider address to the IP it was checked against
  - Restrict per-feature cap keys
  - `executor.ts` auto-approving the default provider
  - Extraction schema vs `ExtractedTask`
  - Old v0.2 comments

### Integrations — `packages/integrations`
- Pending:
  - #19: an integration merge was in progress at the stop. Then reviews, then merge.
  - #36: stacked on #19. Retarget after #19 merges.
  - #63: Sec PASS. Resolve the lockfile conflict, get Arch, merge **before** #67.
  - #67: Sec PASS. Lockfile conflict; Arch needed.
  - #11: check whether it's superseded and close it if so.
- Deferred: dedupe webhook keys on `integrationId:deliveryId`.

### DevOps — infra, workflows, scripts
- Heads:
  - #26 583aef2: Sec PASS, needs Arch.
  - #32 0aac47e: needs a Security recheck of the SHA pins, plus Arch.
  - #34 6694598: needs a Security recheck plus Arch.
  - #40 eadfc94: merge only after #7.
- Blocked:
  - #33: the audit gate is failing, and DevOps is fixing it.
  - #7: the audit gate is failing, and it needs #33 first.
- Environment: the box has no Docker, which blocks the live #7 test. Don't install Docker without asking the coordinator.
- Order: #26, then #34 and #32, then #33, #7, #40.
- Deferred:
  - Keep localhost out of the production redirect allowlist
  - KMS-backed key provider
  - CI check that WXT_WEB_ORIGIN is set

### QA — `tests/`
- #57 1e98b8a and #68 d395f8d: CI green, waiting on Arch and Sec.
- Confirmed: the apps/api test timeouts come from box load, not code (they pass in about a second on integration CI).

### Documentation — `docs/`
- All Arch and Sec findings are fixed and CI is green on all seven PRs. Waiting on re-review.
- #56 also needs one board fix: mark #6 and #25 closed, and #35, #48 and #60 merged.
- Merge order: #28, #31, #56, and #62, #64, #66. #58 merges with or after #21.
- Flagged gap: some ADR-005 MUSTs aren't in merged code yet (refresh-family revocation).

### Native Apps — `apps/extension`, `apps/desktop`, mobile app
- #55 and #60 are merged (extension).
- Desktop app and mobile app (iOS/Android): planned for Phase 8 (offline recording). No code yet, and the frameworks are not decided.
- Deferred, LOW: `validateOrigin` should reject `*` and private or loopback hosts in production builds. Pin the production host once the domain is final.

### Database — `packages/database`
- No open PR. P1-DB-4 work in progress is local only (uncommitted and unpushed). Resume only after Akash restarts work.

### Media/Realtime — `apps/realtime`, `packages/media-core`
- No open PR. Its clone is clean at aacc962.

## Blocked on Akash
- Restarting work after the usage stop.
- Merging #30 (integration into main), plus #70 (these handoff docs).
- Choosing the desktop and mobile app frameworks (Phase 8).
- Confirming Docker Desktop is running on his PC for the local dev stack.
