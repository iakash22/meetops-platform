# 30/60/90-day roadmap for the research proposals (from 2026-11-11)

- Inputs: [feature-proposals.md](feature-proposals.md) (# numbers below), `docs/PHASE_STATUS.md` (9 Nov 2026 update;
  per-phase table from 7 Nov), `docs/HANDOFF.md` (§5 owner blockers, §6 next tasks), `docs/p9/remaining-work.md` and the
  ADRs in `docs/15-decisions/`.
- Day 30 ≈ 11 Dec 2026, day 60 ≈ 10 Jan 2027, day 90 ≈ 9 Feb 2027 (IST). Dates and sizes are **estimates**. We don't know
  team capacity, and several items are blocked on the owner.
- Ground rule: finish what already exists first. Phases P3–P9 are each about 60–98% done (coordinator estimates in
  PHASE_STATUS). Most proposals extend those phases rather than starting new ones.
- Phase names follow the README roadmap. PHASE_STATUS's 7 Nov table calls P6 "Notifications", while the README calls it
  "Live transcription and browser extension". Both are noted below where it matters.

## Where things stand (from PHASE_STATUS 7–9 Nov)

| Phase                               | Estimate | Still open (repo)                                                      |
| ----------------------------------- | -------- | ---------------------------------------------------------------------- |
| P1 Auth, orgs, RBAC                 | ~98%     | MFA, enterprise SSO (ADR-021)                                          |
| P2 Capture, uploads, consent        | ~92%     | Extension Info items                                                   |
| P3 Transcription, AI                | ~85%     | Gemini key (owner), real-provider E2E                                  |
| P4 Tasks, approval                  | ~87%     | —                                                                      |
| P5 GitHub/Jira                      | ~88%     | Jira credentials, GitHub App install (owner)                           |
| P6 Notifications / live + extension | ~87%     | Production email domain (owner); live STT deferred                     |
| P7 Calendar, search, analytics      | ~85%     | Google Calendar OAuth client (owner)                                   |
| P8 Desktop, mobile                  | ~85%     | Native code never compiled; device checklists; bundle ids (owner)      |
| P9 Hardening, billing, release      | ~60%     | Billing (ADR-017), KMS, deploy target, store submission, alert routing |

## Days 0–30: trust and finishing P3/P4/P5 (all P0)

| Proposal                                 | Phase | Backend                                                    | Frontend                        | Native                                    | AI                                                   | QA / Security                                           |
| ---------------------------------------- | ----- | ---------------------------------------------------------- | ------------------------------- | ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| #8 Trust flags in review                 | P3/P4 | Expose flags in the task/insights contracts                | Review-screen section           | —                                         | —                                                    | UI tests                                                |
| #1 Commitment-graded items (v1)          | P3/P4 | Contracts bump (ADR-003), `meeting-insights` storage       | Quote + timestamp in review     | —                                         | `meeting-map@2`, `schemaVersion: 2`, eval fixtures   | Eval on fixtures; injection tests                       |
| #5 Code-switching / Indic                | P3    | Org/meeting language setting                               | Settings field                  | —                                         | AssemblyAI `language_codes` / detection pass-through | Hindi-English fixtures; real-provider E2E (needs key)   |
| #4 No-viral-growth guarantee             | P2/P6 | Policy checks: no non-member mail, no auto-join            | Admin "who may record" settings | Honour policy in extension/desktop/mobile | —                                                    | `tests/security` regression tests                       |
| #6 Two-way sync GA                       | P5    | `task-sync.ts` flag-on path, approvals via `governance.ts` | Batch approve                   | —                                         | —                                                    | E2E on a throwaway repo; webhook replay tests (ADR-007) |
| #7 Routing + assignee suggestion (start) | P4/P5 | Project → repo/Jira mapping; directory-based suggestions   | Confirm UI                      | —                                         | Hint-to-member matching (suggest only)               | RLS / cross-org tests (ADR-010)                         |

Dependencies: Gemini key (owner, HANDOFF §5.3) and AssemblyAI key (PHASE_STATUS owner decisions, "Keys via secure input"); Jira credentials and the GitHub App install (owner,
§5.2 and §5.9). #1 and #8 touch `@meetops/contracts`, so they follow ADR-003 versioning and the one-lockfile-PR-at-a-time rule
if dependencies change.

Exit criteria (**estimates**): approved drafts create real GitHub/Jira issues on a test repo, and status flows back. Each
action item shows a commitment level and a quote. A Hindi-English fixture transcribes with code switching.

## Days 31–60: closed loop and consent you can see (P0 → P1)

| Proposal                                  | Phase | Backend                                                       | Frontend                | Native                                          | AI                               | QA / Security                                   |
| ----------------------------------------- | ----- | ------------------------------------------------------------- | ----------------------- | ----------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| #2 Closed-loop "since last meeting"       | P7/P5 | Series lookup via `calendar_event_links`; status join         | Meeting-page panel      | Mobile/desktop read-only view                   | —                                | Tests for stale status and revoked integrations |
| #3 Consent receipts + self-service revoke | P2/P9 | Signed participant links on the ADR-020 ledger; revoke → stop | Public receipt page     | Stop capture on `consent_revoked` (all clients) | —                                | Link abuse, rate limits, threat-model update    |
| #9 Cross-org meeting mode                 | P2/P7 | External-participant tagging (`meeting-url.ts`)               | Client project tagging  | —                                               | —                                | Output-sharing tests                            |
| #10 Retention and deletion receipts       | P9    | ADR-019 purge job reporting                                   | Admin view              | —                                               | Provider deletion confirmation   | Audit-log checks                                |
| #12 Meeting-to-done analytics (v1)        | P7    | Extend analytics SQL (#348, #392)                             | Dashboard cards (#356)  | —                                               | —                                | Per-org isolation tests                         |
| #13 Duplicate-issue matching              | P5/P7 | Search open issues before create                              | "Linked existing" state | —                                               | Similarity (embeddings, flagged) | Wrong-link tests                                |

Dependencies: the Google Calendar OAuth client (owner, HANDOFF §5.1) for #2. ADR-020 legal review of the notice text
(item 7) before #3 is public. #13 similarity needs an approved, non-free-tier embedding provider (phase-7 notes). The
ADR-020 GDPR erasure plan (an open decision) affects #3.

## Days 61–90: packaging, residency and table stakes (P1)

| Proposal                               | Phase | Backend                                        | Frontend                  | Native         | AI                                         | QA / Security                                  |
| -------------------------------------- | ----- | ---------------------------------------------- | ------------------------- | -------------- | ------------------------------------------ | ---------------------------------------------- |
| #15 Compliance in every paid tier      | P9    | Entitlements (P9 #7, ADR-017)                  | Pricing page / plan gates | —              | —                                          | Entitlement bypass tests                       |
| #11 Biometric-free speaker mode        | P3    | Org setting; no cross-meeting speaker profiles | Speaker mapping UI        | —              | Confirm the provider retains no voiceprint | Counsel / DPA review                           |
| #17 Ask across meetings with citations | P7    | Semantic search GA                             | Ask UI                    | —              | RAG with segment citations                 | Prompt-injection and cross-tenant tests        |
| #18 Pre-meeting brief                  | P6/P7 | Digest job (ADR-013 outbox)                    | Email / in-app templates  | Push on mobile | Brief generation                           | Notification preference tests                  |
| #19 Public API + read-only MCP         | P9    | Scoped tokens, OpenAPI                         | Developer settings        | —              | —                                          | Rate limits (`docs/p9/rate-limit-coverage.md`) |
| #14 India residency (design + spike)   | P9    | Per-org storage region design                  | Region shown in settings  | —              | Provider region check                      | Backup/restore drill per region                |
| #16 Private AI mode (design + spike)   | P3/P9 | Self-hosted worker packaging                   | Admin setting             | —              | faster-whisper / Ollama quality eval       | SSRF / credential-ref review (ADR-009)         |

After day 90 (P2): #20 PII redaction, #21 Slack/Teams digests (product decision for Akash), #22 QR consent on mobile
(after P8 device builds), #23 engineering artefacts, #24 live transcription (needs a streaming adapter and ADR-011
realtime auth).

## Cross-cutting dependencies

1. **Owner inputs (HANDOFF §5).** AI keys, Jira credentials, the GitHub App install and the Google Calendar client block
   #1, #5, #6, #2 and #13 from being tested with real providers. The Google Calendar client also needs Google's brand
   plus sensitive-scope verification, which take about 2–3 plus up to 10 business days, and unverified apps are capped
   at 100 new users ([verification-round-2.md](verification-round-2.md) §1.3).
2. **P8 native builds have never been compiled** (HANDOFF §6). Any native work in #3, #4 or #22 needs the device checklists
   first.
3. **Contracts.** #1, #3, #5 and #7 change `@meetops/contracts` (ADR-003 owner: Architecture).
4. **Billing (ADR-017, Razorpay).** #15 depends on P9 billing wiring, webhooks and entitlements (P9 #5–#7, owner account).
5. **Review gate.** Every PR needs Tester and Security PASS on the exact head and local gates (HANDOFF §3).

## Risks

| Risk                                                                                         | Effect                                          | Mitigation                                                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Owner-blocked credentials stay open                                                          | #1, #5, #6 can't be checked with real providers | Keep fixtures and mocks; ask Akash for the four inputs together                                   |
| Blue-ocean claims turn out to exist at a competitor                                          | Weaker positioning                              | Check products hands-on before any marketing claim (see feature-proposals "Blue-ocean candidate") |
| Legal reading of consent and biometrics (ADR-020, BIPA, EU AI Act Art. 50) differs from ours | Rework of #3 and #11                            | ADR-020 item 7 legal review before GA; don't make compliance claims                               |
| Commitment grading gets worse on real models                                                 | Less trust                                      | Eval gate in `docs/09-ai/ai-evaluation.md`; keep drafts human-approved                            |
| Residency depends on where the AI providers process data                                     | #14 slips                                       | Spike first; document per-provider regions before promising anything                              |
| Team capacity is unknown                                                                     | Dates slip                                      | Treat the 30/60/90 windows as order of work, not commitments                                      |
