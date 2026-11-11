# Feature proposals, ranked (November 2026)

- Inputs: [competitive-landscape.md](competitive-landscape.md) (S… sources), [market-gaps.md](market-gaps.md) (G1–G10, M…
  sources) and the repo on `integration/phase-1` (`de8a86e4`, read 2026-11-11).
- These are proposals, not decisions. Anything that changes contracts, schemas or an ADR needs the usual Architecture and
  Security review, and Akash's sign-off where the ADR says so.

## How we scored (our **estimate**)

| Factor              | Scale                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Value (V)           | 3 = fixes a gap with strong evidence (G1–G10) for our target users; 2 = clear benefit; 1 = nice to have |
| Differentiation (D) | 3 = not seen on any fetched competitor page; 2 = only partly or rarely offered; 1 = table stakes        |
| Fit (F)             | 3 = extends code or ADRs that exist; 2 = new module on existing foundations; 1 = new subsystem          |
| Effort (E)          | S = 1 (≤1 sprint for one team), M = 2 (1–2 sprints, 2 teams), L = 3 (multi-sprint or owner-blocked)     |
| **Score**           | **2V + D + F − E** (higher is better). Priority: P0 ≥ 9, P1 6–8, P2 ≤ 5, with overrides noted           |

**Blue-ocean candidate** means none of the ~19 competitor pages we fetched showed the feature (see the landscape doc). That
evidence is weak: we didn't test every product or read every help centre. Each candidate needs a product check before we
claim it in marketing.

## Ranked list

| #   | Feature                                                             | V   | D   | F   | E   | Score | Priority                          | Blue-ocean candidate | Main gap |
| --- | ------------------------------------------------------------------- | --- | --- | --- | --- | ----- | --------------------------------- | -------------------- | -------- |
| 1   | Commitment-graded, evidence-first action items                      | 3   | 3   | 3   | M   | 10    | P0                                | Yes                  | G4       |
| 2   | Closed-loop follow-through ("since last meeting")                   | 3   | 3   | 3   | M   | 10    | P0                                | Yes                  | G5       |
| 3   | Participant consent receipts and self-service revoke                | 3   | 3   | 3   | M   | 10    | P0                                | Yes                  | G1       |
| 4   | No-viral-growth guarantee and admin-controlled rollout              | 3   | 2   | 3   | S   | 10    | P0                                | No (positioning)     | G2       |
| 5   | Code-switching and Indic-language transcription                     | 3   | 2   | 3   | S   | 10    | P0                                | No                   | G6       |
| 6   | Approval-gated, two-way GitHub/Jira sync (finish P5)                | 3   | 2   | 3   | M   | 9     | P0                                | No                   | G5       |
| 7   | Project-aware routing and assignee suggestion                       | 3   | 2   | 3   | M   | 9     | P0                                | No                   | G4, G5   |
| 8   | Surface trust flags in review (`no-evidence`, `possible-injection`) | 2   | 2   | 3   | S   | 8     | P0 (override: cheap, unblocks #1) | No                   | G4       |
| 9   | Cross-organisation meeting mode                                     | 2   | 2   | 3   | S   | 8     | P1                                | No                   | G9       |
| 10  | Retention and deletion receipts for admins                          | 2   | 2   | 3   | S   | 8     | P1                                | No                   | G7, G10  |
| 11  | Biometric-free speaker mode                                         | 2   | 3   | 2   | M   | 7     | P1                                | Yes (as a guarantee) | G3       |
| 12  | Meeting-to-done analytics                                           | 2   | 2   | 3   | M   | 7     | P1                                | Partly               | G5       |
| 13  | Duplicate-issue matching before create                              | 2   | 1   | 3   | M   | 6     | P1                                | No (note1 has it)    | G5       |
| 14  | India data-residency option                                         | 2   | 3   | 2   | L   | 6     | P1                                | Yes (India)          | G8       |
| 15  | Compliance features in every paid tier                              | 2   | 2   | 2   | M   | 6     | P1                                | No                   | G7       |
| 16  | Private AI mode (local STT/LLM, bring your own key)                 | 2   | 2   | 3   | L   | 6     | P1                                | No                   | G7, G10  |
| 17  | Ask across meetings with segment citations                          | 2   | 1   | 3   | M   | 6     | P1                                | No                   | G4       |
| 18  | Pre-meeting brief from calendar                                     | 2   | 1   | 3   | M   | 6     | P1                                | No                   | G5       |
| 19  | Public API and read-only MCP server                                 | 2   | 1   | 2   | M   | 5     | P1 (override: table stakes)       | No                   | —        |
| 20  | PII redaction before the LLM and on share                           | 2   | 1   | 2   | M   | 5     | P2                                | No                   | G7       |
| 21  | Slack/Teams digests and in-chat approvals                           | 2   | 1   | 2   | M   | 5     | P2                                | No                   | G5       |
| 22  | In-person consent by QR code (mobile)                               | 1   | 3   | 2   | M   | 5     | P2                                | Yes                  | G1       |
| 23  | Engineering artefacts: decisions → ADR or PR description drafts     | 1   | 2   | 2   | M   | 4     | P2                                | Weak candidate       | G5       |
| 24  | Live transcription and in-meeting capture                           | 2   | 1   | 1   | L   | 3     | P2                                | No                   | —        |

## Details

### 1. Commitment-graded, evidence-first action items (P0, M)

- **Evidence.** Users report discussions turned into "decisions" and owners guessed wrong. They ask for "unclear
  attribution" flags and quotes as proof [S35, S36]. Otter's top G2 complaints are accuracy and speaker problems [S34].
- **What.** Each decision or action gets a commitment level (`proposed`, `discussed`, `decided` / `committed`), an owner
  confidence, and an explicit "owner unclear" state instead of a guess. The review screen shows the quote and a jump to the
  timestamp for every item.
- **Fit.** `packages/ai-core/src/extraction/*` already resolves `{ segmentId, startSec, endSec }` evidence and flags
  `no-evidence`. `assigneeHint` stays untrusted, display-only text (`docs/09-ai/summaries-and-tasks.md`). This needs
  `meetingExtractionSchema` `schemaVersion: 2`, a new prompt version (`meeting-map@2`) and a contracts bump (ADR-003). The web
  `task-review` feature renders it.
- **Teams.** AI (prompt, schema, eval fixtures in `docs/09-ai/ai-evaluation.md`), backend (contracts, API), frontend
  (review UI), QA.

### 2. Closed-loop follow-through, "since last meeting" (P0, M)

- **Evidence.** The summary-to-execution gap [M3]. Competitors push tasks one way (Fireflies → Linear [S21], tl;dv → Jira and
  others [S4b]) or sync through Zapier (Fellow ↔ GitHub [S25]). We found no live status view across meeting instances.
- **What.** For a recurring meeting, show tasks from the previous instance with their live GitHub/Jira status, overdue items
  and who owns them. The same view can go out as a pre-meeting digest.
- **Fit.** `calendar_event_links` and background sync (`apps/worker/src/calendar/sync.ts`) know the series.
  `packages/integrations/src/status-sync.ts` and `jira-webhook.ts` already map provider events to the task's status.
  ADR-013 outbox + BullMQ handles the digest.
- **Teams.** Backend, integrations, frontend. Depends on #6 and on the Google Calendar OAuth client (owner).

### 3. Participant consent receipts and self-service revoke (P0, M)

- **Evidence.** Wiretap and BIPA suits centre on non-users never asked [S30–S33]. Where competitors track consent, it is
  optional or tier-gated [S13, S23, S16].
- **What.** Each participant gets a link (no account needed) showing which notice version they saw, when, and how consent
  was given (`all_parties_notified` or `all_parties_consented`). One click revokes: capture stops and a deletion request
  is logged.
- **Fit.** ADR-020 already has the append-only `consent_attestations` and `meeting_consent_events` ledger,
  `CURRENT_CONSENT_VERSION`, and "capture stops on `consent_revoked`". Code: `apps/api/src/modules/media/*meeting-consent*`,
  `packages/contracts/src/api/meeting-consent.ts`. Open item: the GDPR Art. 17 erasure plan for attesters (ADR-020 notes).
- **Teams.** Backend, frontend, native (extension, desktop and mobile revoke handling), security (signed, rate-limited
  links), QA. Legal review of the notice text (ADR-020 item 7).

### 4. No-viral-growth guarantee and admin-controlled rollout (P0, S)

- **Evidence.** Bots "spread like viruses" through attendee emails and calendar access [M1, M2].
- **What.** Written product guarantees, each with a test: never join a meeting on our own, never email people outside the
  org, never use attendee lists to sign people up. Admin controls over who may record, plus the ADR-020 option to skip
  meetings with external participants.
- **Fit.** Capture is already botless (extension, desktop, mobile). ADR-020 items 2 and 4. Notifications go only to org
  members (ADR-013). Mostly policy, tests (`tests/security`) and settings UI.
- **Teams.** Frontend (settings), backend (policy checks), QA/security (regression tests).

### 5. Code-switching and Indic-language transcription (P0, S)

- **Evidence.** Hindi-English meetings transcribe badly in several tools [S37]. Otter covers six languages, with no Hindi
  [S1]. Gemini handles one language per meeting [S16]. AssemblyAI documents code switching across 18 languages, Hindi
  included, with `language_detection` or `language_codes` [M4].
- **What.** An org and per-meeting language set (for example `["en","hi"]`), code-switching on by default for those orgs,
  and summaries in a chosen output language.
- **Fit.** The AssemblyAI adapter already passes `language_code | language_detection` (`docs/09-ai/transcription.md`). It
  needs a `language_codes` pass-through, a model setting, and an output-language field in the extraction prompt. ADR-009
  routing still applies, with no paid fallback.
- **Teams.** AI and backend; QA with Hindi/English fixtures. Needs the owner's AssemblyAI key for a real-provider eval.

### 6. Approval-gated, two-way GitHub/Jira sync (P0, M)

- **Evidence.** Task push is now common [S21, S4b, S25]. What sets us apart is human approval before any write, plus status
  coming back.
- **What.** Ship the P5 flow to general availability: batch approve, the issue is created in the mapped repo or project,
  and status flows back.
- **Fit.** `packages/integrations/src/governance.ts` requires a single-use approval bound to a payload hash before
  `createIssue` or `updateStatus`. `apps/api/src/modules/integrations/task-sync.ts` sits behind `TASK_SYNC_ENABLED`. ADR-007
  and ADR-008.
- **Blocked on the owner.** Jira credentials, and installing the GitHub App on a throwaway repo (HANDOFF §5).

### 7. Project-aware routing and assignee suggestion (P0, M)

- **What.** Use the directory (employees, teams, projects) to suggest the target repo or Jira project and same-org assignees
  for each draft. A human confirms. This is the README's "Employee matching" step.
- **Fit.** `apps/api/src/modules/{employees,teams,projects}`, plus `summaries-and-tasks.md` ("Backend may suggest same-org
  members, but a human must confirm").
- **Teams.** Backend, AI, frontend.

### 8. Surface trust flags in the review UI (P0 override, S)

- **What.** Show `no-evidence` and `possible-injection` items in their own section, kept as drafts, with an explanation.
- **Fit.** The flags already exist in the extraction pipeline. This is UI and contracts exposure only.

### 9. Cross-organisation meeting mode (P1, S)

- **Evidence.** Copilot doesn't work in meetings hosted outside the participant's organisation [S17].
- **What.** Treat client-hosted meetings as first-class: tag them to a client project, use stricter consent defaults, and
  never share outputs with external attendees.
- **Fit.** Botless capture already works on any tab or app. `packages/integrations/src/meeting-url.ts` derives external call
  ids. Consent per ADR-020.

### 10. Retention and deletion receipts for admins (P1, S)

- **Evidence.** Custom retention is mostly Enterprise-only at competitors [S2, S3, S6, S7, S14].
- **What.** Show the admin what was purged and when, including the confirmation that AI provider copies were deleted.
- **Fit.** ADR-019 (daily purge job, provider copies deleted after processing, audit logs kept at least a year).
  `apps/worker/src/privacy/ip-retention.ts` is the pattern to follow.

### 11. Biometric-free speaker mode (P1, M)

- **Evidence.** BIPA suits over voiceprints [S32, S33].
- **What.** An org setting: speakers stay per-recording labels (S1…Sn) that a human maps to people. No voice profile is
  kept across meetings.
- **Fit.** `mergeChunkTranscripts` maps chunk-local labels to recording-wide `S1, S2…` by time overlap, not voice
  embeddings (`docs/09-ai/transcription.md`).
- **Open question.** Whether AssemblyAI diarization counts as creating a voiceprint under BIPA. Needs counsel and the
  provider's DPA.

### 12. Meeting-to-done analytics (P1, M)

- **What.** Per team and project: tasks proposed, approved, done; median time from meeting to done; meetings that produced
  no approved work.
- **Fit.** The analytics endpoint and dashboard (#348, #356, #392) and `apps/web/src/features/analytics`. Done status comes
  from #6.
- **Note.** Read.ai and Fireflies offer meeting and team analytics [S6, S2]. We didn't see "meeting → done" cycle time on
  their pages, so this is only partly differentiated.

### 13. Duplicate-issue matching before create (P1, M)

- **Evidence.** note1 searches open and recently closed issues and links them before creating anything [S26].
- **Fit.** GitHub and Jira adapters in `packages/integrations`. Matching could use the embeddings pipeline (P7), which
  needs an approved, non-free-tier embedding provider (phase-7 notes).

### 14. India data-residency option (P1, L)

- **Evidence.** Residency choices we found cover the EU, US and Canada only [S6, S12, S13]. DPDP duties start on
  13 May 2027 (ADR-019).
- **Fit.** `StorageService` already switches by config (`STORAGE_PROVIDER`, `STORAGE_REGION`). Per-org region pinning
  touches storage keys (ADR-010 layout), backups (ADR-019) and the AI providers' processing regions. That last part isn't
  verified and is an open question.
- **Teams.** DevOps, backend, security. Owner decisions on hosting and providers.

### 15. Compliance features in every paid tier (P1, M)

- **Evidence.** HIPAA, SSO and retention are tier-gated at most competitors [S1, S2, S6, S7, S8, S12, S14]. Fathom is the
  exception [S3].
- **What.** Pricing and packaging: consent controls, retention, audit logs and (once built) SSO in every paid plan.
- **Fit.** ADR-017 entitlements (P9 #7), ADR-021 MFA/SSO (not built). HIPAA is **not** proposed: there is no BAA, no
  assessment, and the README says we make no compliance claims without evidence.

### 16. Private AI mode: local STT/LLM, bring your own key (P1, L)

- **Evidence.** Meetily keeps audio and transcripts on the device [S19]. Krisp Enterprise offers on-device private
  transcription [S12]. Jamie Enterprise offers BYOK/CMEK [S15].
- **Fit.** faster-whisper and Ollama adapters exist (`packages/ai-core/src/adapters`). The ADR-009 router and credential
  refs, SSRF guard (port 443 for remote endpoints) and ADR-016 KMS are in place. The work is packaging a self-hosted worker
  and testing quality.

### 17. Ask across meetings with segment citations (P1, M)

- Table stakes: Fathom "Ask Fathom", Fireflies "AskFred", Granola and Read chat [S3, S2, S7, S6].
- **Fit.** Semantic search (`apps/api/src/modules/search/semantic.ts`, `SEMANTIC_SEARCH_ENABLED`) and the embeddings
  pipeline. Answers must cite segment ids, the same as extraction. Needs a non-free-tier embedding and LLM provider for
  customer data.

### 18. Pre-meeting brief from calendar (P1, M)

- Table stakes: Granola Business pre-meeting briefs [S7], Jamie briefings [S15], ZoomMate prep [S10b].
- **Fit.** Calendar sync plus the #2 data, delivered through ADR-013 notifications.

### 19. Public API and read-only MCP server (P1 override, M)

- Table stakes: at least ten vendors advertise MCP ([market-gaps.md](market-gaps.md) §3).
- **Fit.** `@meetops/contracts` and OpenAPI already exist. Start read-only, scoped per org with RLS (ADR-010). Writes stay
  behind governance approvals.

### 20. PII redaction before the LLM and on share (P2, M)

- Fellow Enterprise offers transcript redaction [S25b].
- **Fit.** `buildTranscriptPrompt()` already fences untrusted text. A redaction pass would run before the prompt and when
  sharing outputs.

### 21. Slack/Teams digests and in-chat approvals (P2, M)

- **Fit.** ADR-013 channel fan-out. Approvals must still consume a single-use governance approval.
- **Note.** The team rule "No Slack" covers project operations only. A Slack product integration is a product decision for
  Akash.

### 22. In-person consent by QR code on mobile (P2, M)

- **What.** The recorder shows a QR code. Attendees scan it to see the notice and can revoke without an account.
- **Fit.** Mobile consent sheet (`apps/mobile/src/consent`) plus #3. Blue-ocean candidate: not found on any fetched page.

### 23. Engineering artefacts: decisions → ADR or PR description drafts (P2, M)

- **What.** Turn decisions into a draft ADR file or a PR description through the GitHub App, approval-gated like tasks.
- **Weak candidate:** we didn't search specifically for this.

### 24. Live transcription and in-meeting capture (P2, L)

- Otter, Fireflies, Read and Avoma advertise live notes or transcription [S1, S2, S6, S8].
- **Fit.** Weak today. The `live-transcription` feature needs the `streaming-transcription` capability, and no adapter
  declares it (`docs/09-ai/transcription.md`). It also touches realtime auth (ADR-011).

## Top 5 summary

1. **#1 Commitment-graded, evidence-first action items.** This addresses the trust complaint we heard most and builds on
   evidence code that already exists.
2. **#2 Closed-loop follow-through.** It turns status sync into a feature people see every week. We found it on no
   competitor page.
3. **#3 Participant consent receipts.** This makes ADR-020 visible to the people being recorded, which is where the
   lawsuits land.
4. **#4 No-viral-growth guarantee.** Almost free for us, since capture is already botless, and it answers the IT and admin
   backlash.
5. **#5 Code-switching and Indic languages.** A small change on our default STT provider that serves the owner's home
   market.
