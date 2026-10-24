# MeetOps AI — Agent Work Status and Pending Work

> Snapshot: 2026-10-24 ~15:10 IST, from the coordinator's records and live `gh pr list`. Work is running. **Priority (Akash, 14:27 IST): clear all open PRs before new work.** Read `docs/PROJECT_CONTEXT.md` first. No secrets.

Key: **Arch** = Architecture PASS, **Sec** = Security PASS, both posted as PR comments on the exact head SHA. Integration = `integration/phase-1` (head `3dd2cda`). CI is replaced by local gates while GitHub Actions minutes are exhausted (Akash, 15:06 IST).

## Summary (open PRs by agent, owner inferred from branch name)

| Agent | Next-phase focus | Open PRs |
|---|---|---|
| Architecture | contracts v0.3.3, boundary lint (push OK pending Akash line in Architecture chat) | #104, #105 |
| Security | reviews (Sec PASS on exact head SHA) | none |
| Backend | contracts v0.3.3 error envelope, Redis lockout | #98, #103 |
| Frontend | GitHub App / extension pairing UI (#84 merged) | none |
| Database | tenant key migration (ADR-010), seeds, RLS isolation tests, AI usage tables | #81, #87, #89, #91, #93, #97, #100 |
| DevOps | CI hardening, dependency upgrades, compose fixes | #7, #26, #32, #40, #95, #99, #101, #102 |
| Media and Realtime | S3/MinIO uploads, organizations/{organizationId}/ keys, FFmpeg worker, realtime status | #77, #82, #85, #88, #90, #92, #94, #96 |
| AI | transcription consumer and summaries (AssemblyAI default, Whisper option) | #75, #83 |
| Integrations | GitHub App and pairing (#63, #67 merged) | none |
| Native Apps | Expo mobile app (M1 scaffold); desktop Tauri later | #78 |
| QA | QA hardening (#107 merged, supersedes #57) | #34 |
| Documentation | docs refresh, runbooks | #31, #56, #80 |

Full open-PR table with branches and titles: `docs/PROJECT_CONTEXT.md` section 6.

## Per agent

### Architecture (reviewer + contracts)
- Open: #104 (contracts v0.3.3), #105 (boundary lint). Push OK needs Akash's own line in Architecture's own chat.
- Reviews: Arch PASS comment on the exact head SHA for every open PR.

### Security (reviewer)
- Sec PASS comment on the exact head SHA for every open PR; confirm the gitleaks exception is only `packages/ai-core/test/credential-ref.test.ts:26` (two fake values).

### Backend — `apps/api`
- Open: #98 (Redis lockout), #103 (v0.3.3 error envelope, depends on #104).

### Frontend — `apps/web`
- No open PR. #69, #72, #76, #84 merged.

### Database — `packages/database`
- Open: #81 (ADR-010), #87, #89, #91, #93, #97, #100. Tenant key migration: `org/` → `organizations/{organizationId}/`; dev wipe/reseed, staging copy, keep reading `org/` keys until the copy is verified (approved by Akash).

### DevOps
- Open: #7, #26, #32, #40, #95, #99, #101, #102. Actions minutes exhausted: run local gates. Docker isn't running on Akash's PC.

### Media and Realtime
- Open: #77, #82, #85, #88, #90, #92, #94 (stacked chain starting at #77), #96 (storage key migration runbook).

### AI — `packages/ai-core`
- Open: #75, #83. AssemblyAI default, Whisper option, no Deepgram; live streaming and embeddings deferred. #21, #47 merged.

### Integrations
- No open PR. #19, #63, #67 merged; #36 closed.

### Native Apps
- Open: #78 (Expo M1 scaffold). Desktop: Tauri (Phase 8). Mobile: React Native + Expo.

### QA
- Open: #34. #107 merged (absorbs #57's E2E flow tests); #57 closed (approved).

### Documentation
- Open: #31, #56, #80. #58, #62, #64 closed.

## Blocked on Akash
- Architecture push OK for contracts v0.3.3 and boundary lint (in Architecture's own chat).
- Optional GitHub token rotation.
- Merges into `main` (#30 was merged 2026-10-24 13:48 IST; the next integration → main PR waits for Akash).
- Closure approval for any open PR that won't be merged.
