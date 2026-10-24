# MeetOps AI — Agent Work Status and Pending Work

> Snapshot: 2026-10-24 ~15:25 IST (refreshed), from the coordinator's records and live `gh pr list`. Work is running. **Priority (Akash, 14:27 IST): clear all open PRs before new work.** Read `docs/PROJECT_CONTEXT.md` first. No secrets.

Key: **Arch** = Architecture PASS, **Sec** = Security PASS, both posted as PR comments on the exact head SHA. Integration = `integration/phase-1` (head `ac96ad7`). CI is replaced by local gates while GitHub Actions minutes are exhausted (Akash, 15:06 IST).

## Summary (open PRs by agent, owner inferred from branch name)

| Agent | Next-phase focus | Open PRs |
|---|---|---|
| Architecture | contracts v0.3.3, boundary lint (push OK pending Akash line in Architecture chat) | #104, #105 |
| Security | reviews (Sec PASS on exact head SHA) | none |
| Backend | contracts v0.3.3 error envelope, Redis lockout | #98, #103 |
| Frontend | GitHub App / extension pairing UI (#84 merged) | none |
| Database | tenant key migration (ADR-010), chunk files, constraints | #89, #91, #93, #97, #100 |
| DevOps | CI hardening, dependency upgrades, compose fixes | #7, #26, #32, #40, #95, #99, #101, #102 |
| Media and Realtime | S3/MinIO uploads, organizations/{organizationId}/ keys, FFmpeg worker, realtime status | #77, #82, #85, #88, #90, #92, #94, #96 |
| AI | transcription consumer and summaries (AssemblyAI default, Whisper option) | #83 |
| Integrations | GitHub App and pairing (#63, #67 merged) | none |
| Native Apps | Expo mobile app (M1 scaffold); desktop Tauri later | #78 |
| QA | QA hardening (#107 merged, supersedes #57) | #34 |
| Documentation | docs refresh, runbooks | #31, #56, #80 |

Full open-PR table with heads and review status: `docs/PROJECT_CONTEXT.md` section 6. Since 15:10 IST: #75, #81, #87 merged; #109 opened.

## Per agent — pending work in detail
(verified: PR open/merged/closed state and Security PASS comments; Architecture verdicts **not found** in PR comments, so "needs Arch" is assumed; items marked *unverified* are from the coordinator's records only)

### Architecture (reviewer + contracts)
- #104 contracts v0.3.3 (`2b411c4`): no Sec/Arch comment yet. **Waiting on Akash**: push OK must come as Akash's own line in Architecture's own chat.
- #105 boundary lint (`2ceb86f`): same as #104.
- Next queued: mobile bearer-token ADR amendment (ADR-005), then the org-switch, consent and upload contracts.
- Reviews owed: Arch PASS on exact head for every open PR (none found in comments).
- #80 zod 4 plan (Documentation-owned branch): **failed Architecture review** (*unverified* in PR comments; Sec PASS on an older SHA) and needs doc fixes, then re-review.

### Security (reviewer)
- Re-review needed (Sec PASS only on an older SHA): #31, #77, #80, #82, #85, #88, #90, #92.
- No Sec verdict yet: #7, #26, #32, #34, #40, #94, #95, #96, #97, #100, #101, #102, #104, #105.
- gitleaks: only allowed exception is `packages/ai-core/test/credential-ref.test.ts:26` (two fake values).

### Backend — `apps/api`
- #98 Redis lockout counters + lockout email (`71cf1a8`): Sec PASS on head; needs Arch.
- #103 v0.3.3 error envelope (`0dd4d6e`): Sec PASS on head; needs Arch; depends on #104.
- Next queued: the `/docs` gate fix (*unverified*), remaining lockout follow-ups (Redis counter, error envelope, lockout email: covered by #98/#103), then upload routes, the consent API and mobile bearer auth (after the Architecture ADR amendment).

### Frontend — `apps/web`
- No open PR (#69, #72, #76, #84 merged). Next: UI for upload/consent once contracts land (*unverified*).

### Database — `packages/database`
- #89 RLS isolation tests (`107cb64`): Sec PASS on head; needs Arch.
- #91 multi-org seed (`c9c0c8a`): Sec PASS on head; needs Arch.
- #93 AI usage / transcript chunks (`faa2ff7`): Sec PASS on head; needs Arch.
- #97 recordings.chunk_count + chunk FileObject repository (`6398b00`): needs Sec + Arch.
- #100 org/ + organizations/ key prefixes (`c049c4c`, MERGEABLE): needs Sec + Arch.
- Next queued: chunk_count migration and chunk file repositories (in #97), hex checksum DB constraint (pairs with #94), key-prefix constraint (after #100).

### DevOps
- Rework: #7 (devops containers/CI), #26 (commitlint), #32 (Windows/Node 24), #34 (QA CI jobs), #40 (fast pre-commit): no Sec/Arch on current heads; need rework/integration merge and reviews.
- Dependency PRs: #99 nodemailer 10 (Sec PASS on head, needs Arch), #101 testcontainers 11, #102 vitest 4 + vite 7 (both need Sec + Arch).
- #95 MinIO compose fix: needs Sec + Arch.
- Next queued: vitest 4 (#102), the dev storage wipe/reseed after #82 merges, and the staging copy job (org/ → organizations/).
- Note: GitHub Actions minutes are out; run local gates. Docker isn't running on Akash's PC.

### Media and Realtime
- Upload-security stack, merge in order: #77 (`f40fc15`) → #82 → #85 / #88 → #90 / #92 → #94. All have Sec PASS only on older SHAs (#94 none): **re-review needed**, plus Arch.
- #94 is the checksum-format fix (lowercase hex at the S3 boundary).
- #82 is the `organizations/{organizationId}/` key move; old `org/` reads stay until the staging copy is verified.
- #96 storage key migration runbook: needs Sec + Arch.

### AI — `packages/ai-core`
- #75 **merged** (since last snapshot).
- #83 transcription worker (`087b556`, MERGEABLE): Sec PASS on head; needs Arch, then merge.

### Integrations
- #67 is **already merged** (verified); no open Integrations PR. Next: GitHub App and pairing follow-ups (*unverified*).

### Native Apps
- #78 Expo M1 scaffold (`f037dee`): Sec PASS on head, but **merge conflict**; fix the stale lockfile and critical advisories (*advisories unverified*), merge integration in, then Arch.
- Next queued: mobile login screens and secure token storage against a mock; real login is blocked on the bearer ADR (Architecture) and Backend.

### QA
- #57's E2E flow tests are already moved: #107 (`test/qa-hardening-1`) **merged** and #57 **closed** (verified).
- #34 QA CI jobs (DevOps-labelled above) still needs rework and reviews.

### Documentation
- #31 refresh (`b13b4d8`): Sec PASS on older SHA; needs refresh, re-review, Arch.
- #56 (base `docs/refresh-heads`, Sec PASS on head): retarget to integration or close; **closing needs Akash's yes**.
- #80 zod 4 plan: failed Arch review, needs doc fixes (see Architecture).

### Project Lead
- #109 this handover (base `main`): Akash merges.

## Blocked on Akash
- Architecture push OK for contracts v0.3.3 and boundary lint (in Architecture's own chat).
- Optional GitHub token rotation.
- Merges into `main` (#30 was merged 2026-10-24 13:48 IST; the next integration → main PR waits for Akash).
- Closure approval for any open PR that won't be merged.
- Next integration → main PR after open PRs clear (Akash merges).
