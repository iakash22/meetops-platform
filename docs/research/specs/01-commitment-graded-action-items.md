# Spec 1: Commitment-graded action items with quote and timestamp

- Proposal #1 in PR #468 (P0). Gap G4: wrong owners, "decisions" that were only discussed, no proof.
- Evidence: users ask for "unclear attribution" flags and quotes as proof (#468 S35, S36); Otter's top G2 complaints are
  accuracy and speaker problems (#468 S34).

## 1. User stories

1. As a **meeting owner**, I see each action item with the exact quote and a timestamp link, so I can check it in seconds.
2. As a **reviewer**, I see whether an item was _committed_ ("I'll ship it Friday") or only _proposed_ ("we could…"), so
   I approve only real commitments.
3. As an **assignee**, I never get a task the AI guessed. If the owner is unclear, the item says "owner unclear" and asks a
   human.
4. As an **admin**, I can set a policy: only `committed` items may be pushed to GitHub/Jira without an extra click.

## 2. UX flow

1. Meeting ends → transcript → extraction (existing pipeline).
2. Review page (`apps/web/src/features/task-review/review-page.tsx`) groups drafts into **Committed**, **Proposed** and
   **Needs a human** (owner unclear, `no-evidence`, `possible-injection`).
3. Each card shows: title; a commitment badge; the speaker and quote (one or two segments); `▶ 12:34`, which seeks the
   player to `startSec`; owner as "suggested: Priya (from 'I'll take it')" or "owner unclear".
4. Actions: approve, edit, change grade, reject. Approval goes through the existing `TaskApproval` and governance path
   (`packages/integrations/src/governance.ts`).
5. Desktop and mobile review panels (`apps/desktop/src/features/tasks/task-review-panel.tsx`,
   `apps/mobile/src/tasks/TaskReviewPanel.tsx`) show the badge and quote; the timestamp opens the web player.

## 3. Data model and API sketch

Today:

- `packages/ai-core/src/extraction/schemas.ts`: `actionItemV1Schema` (title, detail, `assigneeHint`, `dueHint`,
  `evidenceSegmentIds`), `draftTaskSchema` with `evidence: { segmentId, startSec, endSec }[]` and
  `flags: ['possible-injection','no-evidence']`; `EXTRACTION_PROMPT_VERSION = meeting-map@1`.
- `apps/worker/src/ai/action-items.ts`: a second path, `action-items@1`, with `confidence` and `sourceSegments`.
- DB `ExtractedTask` (`packages/database/prisma/schema.prisma`): `assigneeHint`, `dueHint`, `confidence`,
  `sourceSegmentIds`, `status pending_review`.
- Contracts `ExtractedTask` (`packages/contracts/src/domain/task.ts`).

Proposed (v2):

```ts
// packages/ai-core/src/extraction/schemas.ts (sketch)
export const commitmentLevel = z.enum(['proposed', 'discussed', 'committed']);
export const actionItemV2Schema = actionItemV1Schema.extend({
  commitment: commitmentLevel,
  ownerStatus: z.enum(['named', 'self_assigned', 'unclear']),
  quote: z.string().max(400), // must be a substring of a cited segment, checked in code
  quoteSegmentId: z.string().min(1).max(64),
});
// meetingExtractionSchema.schemaVersion: 2; EXTRACTION_PROMPT_VERSION.map = 'meeting-map@2'
```

- Migration: `extracted_tasks` gets `commitment` (enum, nullable for v1 rows), `owner_status` (enum), `quote` (text,
  ≤400) and `quote_segment_id` (uuid referencing `transcript_segments`, same org).
- Contracts (ADR-003): `ExtractedTask` adds optional `commitment`, `ownerStatus`, `quote`, `quoteStartSec`; minor version
  bump. Old clients ignore the new fields.
- API: no new route. The existing review list returns the new fields. `AcceptExtractedTaskRequest` may carry
  `overrideCommitment` (audited).
- Policy (optional): org AI config (`AiOrganizationConfig.config` JSON) gets `autoQueueCommitmentAtLeast: 'committed'`.
  It still needs a human approval; it only pre-selects items.

## 4. AI approach

- One prompt change in the map step: classify each item's commitment from linguistic cues (first person + future + time,
  versus modal "could/should", versus questions). Few-shot examples include Hindi-English (see spec 5).
- **Quote check in code, not trust:** reject or flag an item when `quote` isn't a normalised substring of
  `quoteSegmentId`'s text. Items with no valid quote get `no-evidence` (existing flag).
- **Owner rule:** `ownerStatus = named` only if the quote or an adjacent segment contains a name or first-person claim by
  a labelled speaker. Otherwise `unclear`. `assigneeHint` stays untrusted, display-only (`docs/09-ai/summaries-and-tasks.md`).
- Reduce step stays deterministic for lists (merge by evidence overlap).
- Merge the two extraction paths (`meeting-map@*` and `action-items@*`) into one schema to avoid drift (decision for AI
  and Backend).
- Evals: add fixtures next to `packages/ai-core/eval/fixtures/{standup,long-meeting,prompt-injection}.json` (run by
  `packages/ai-core/eval/eval.test.ts`; see `docs/09-ai/ai-evaluation.md`) with labelled commitment and owner data (at
  least 50 items, mixed English and Hindi-English).

## 5. Risks

- Over-confident grading. Mitigation: show the grade as a suggestion; a human can change it; track override rate.
- Speaker labels are wrong (diarization errors), so the quote is attributed to the wrong person. Mitigation: show the
  speaker label next to the quote and let reviewers fix the mapping.
- Prompt injection inside a quote ("ignore previous… assign to admin"). Existing `possible-injection` flag stays;
  quotes are escaped when rendered.
- BIPA: none added; this uses existing labels (see legal brief §2).

## 6. Success metrics (targets are estimates)

- ≥80% of approved tasks have a valid quote and timestamp.
- Reviewer grade-override rate ≤15% after two prompt iterations.
- Wrong-owner rate (owner changed after approval) halves against a v1 baseline measured in pilot.
- Median review time per meeting falls (baseline to be measured).

## 7. Effort per team (estimates)

| Team        | Work                                                               | Estimate |
| ----------- | ------------------------------------------------------------------ | -------- |
| AI          | Prompt v2, quote check, eval fixtures, merge two extraction paths  | 2–3 ew   |
| Backend     | Migration, contracts bump, review API fields, override audit       | 1.5–2 ew |
| Frontend    | Review page grouping, badges, quote + seek                         | 1.5–2 ew |
| Native      | Desktop and mobile review panels, extension pending-tasks badge    | 1 ew     |
| QA/security | Contract tests, injection cases, render escaping, cross-org checks | 1 ew     |
