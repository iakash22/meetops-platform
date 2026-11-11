# Executive summary: product research (November 2026)

- For Akash and the project lead. One page, drawn from the merged research docs (#468) and the docs in **#473, which is
  still in review** (linked below by the paths they will have once #473 merges; marked "pending #473").
- Everything here is a **proposal** unless it is marked as a project-lead decision. Scores, efforts and prices are
  **estimates**. Facts cite the doc they come from; those docs cite the primary sources.

## The headline

MeetOps should not sell "another AI note-taker". It should sell **meeting → approved GitHub/Jira work, with proof**,
captured without a bot, with consent people can see, and working in Hindi-English meetings, priced in INR
([competitive-landscape.md](competitive-landscape.md) §5; [market-gaps.md](market-gaps.md) §4).

## Top 10 bets

Ranked by the #468 score (2V + D + F − E, an estimate) in [feature-proposals.md](feature-proposals.md). Effort figures for
1–5 are the per-spec estimates in [specs/README.md](specs/README.md) (pending #473).

| #   | Bet                                                         | Why (gap)                                                                     | Status / effort (estimate)                                                           |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Commitment-graded action items with quote and timestamp     | Users say provenance is missing and owners get guessed (G4)                   | P0; [spec 01](specs/01-commitment-graded-action-items.md) ~7–9 ew (pending #473)     |
| 2   | "Since last meeting": live GitHub/Jira status of last tasks | Summaries stop short of execution; no live loop found at competitors (G5)     | P0; [spec 02](specs/02-since-last-meeting.md) ~8–11 ew (pending #473)                |
| 3   | Consent receipts with one-click revoke                      | Lawsuits centre on people who were never asked (G1)                           | P0; [spec 03](specs/03-consent-receipts.md) ~10–13 ew (pending #473)                 |
| 4   | No-viral-growth guarantee and admin-controlled rollout      | IT admins report bots that spread on their own (G2)                           | P0; [spec 04](specs/04-no-viral-growth-guarantee.md) ~5–7 ew (pending #473)          |
| 5   | Mixed-language and Indic transcription                      | Hindi-English meetings fail in several tools; suites handle one language (G6) | P0; [spec 05](specs/05-mixed-language-indic-transcription.md) ~6–8 ew (pending #473) |
| 6   | Approval-gated two-way GitHub/Jira sync to GA (finish P5)   | Push is common; human approval plus status coming back is not (G5)            | P0; blocked on Jira credentials and GitHub App install (owner)                       |
| 7   | Project-aware routing and assignee suggestion               | Users report action items given to the wrong person (G4, G5)                  | P0                                                                                   |
| 8   | Show trust flags (`no-evidence`, `possible-injection`)      | Flags already exist in the pipeline; cheap and unblocks #1 (G4)               | P0 override, small                                                                   |
| 9   | Cross-organisation meeting mode                             | Copilot doesn't work in meetings hosted outside the participant's org (G9)    | P1, small                                                                            |
| 10  | Retention and deletion receipts for admins                  | Custom retention is mostly Enterprise-only at competitors (G7, G10)           | P1, small                                                                            |

## Why we win

1. **The core flow is the unmet need.** Evidence-linked drafts → human approval → GitHub/Jira → status sync already exist in
   the repo ([feature-proposals.md](feature-proposals.md) #1, #6). Competitors push tasks one way or through Zapier
   ([market-gaps.md](market-gaps.md) G5).
2. **Trust is built in, not sold up-tier.** Capture is botless; ADR-020 sets all-party consent everywhere. Competitors gate
   consent and retention to higher tiers ([market-gaps.md](market-gaps.md) G1, G7). The botless choice does **not** remove
   consent risk: a class action targets Granola's bot-free notetaker
   ([verification-notes.md](verification-notes.md) L4, pending #473).
3. **India is an open lane.** No AI-notetaker vendor we checked showed INR to an India visitor; Google, Microsoft and Zoom
   did ([pricing-packaging.md](pricing-packaging.md) §2, pending #473). Copilot's work/school language list has no Hindi,
   and Gong transcribes only a call's majority language ([verification-notes.md](verification-notes.md) V3, V8, pending
   #473).

## What to build first

1. **Days 0–30** ([roadmap-plan.md](roadmap-plan.md)): #8 trust flags, #4 no-viral guarantee (mostly policy and tests),
   #5 language settings, #1 schema v2, #7 routing (start), and #6 sync GA once the owner provides credentials.
2. **Then** #3 consent receipts (needs the ADR-020 amendment and legal input) and #2 "since last meeting" (needs P5 sync
   live and calendar series data). This is the order in [specs/README.md](specs/README.md) (pending #473).
3. **Before any paid launch:** a non-free-tier LLM for customer data ([../plans/phase-7-notes.md](../plans/phase-7-notes.md)),
   billing (P9, ADR-017) and the ADR-020 item 7 legal review. GTM detail is in
   [gtm-india-smb-midmarket.md](gtm-india-smb-midmarket.md).

## Project-lead decisions (2026-11-12)

- The ADR-020 bot-notice mismatch and the consent default go into an **ADR-020 amendment owned by the All Rounder Techy
  agent** ([legal-questions-brief.md](legal-questions-brief.md) §4, pending #473).
- The **host-only consent ledger is a tracked feature gap** and the backbone of spec 03.
- Spec 05's new meeting-languages route is **decided at implementation**.
- **Sarvam is opt-in, off by default and capped, with no spend until Akash sets a budget.**

## Open items

- Still-unverified facts are listed in [verification-notes.md](verification-notes.md) §3 (pending #473).
- Counsel questions (BIPA, EU AI Act Art. 50, ADR-020) are in [legal-questions-brief.md](legal-questions-brief.md) §5
  (pending #473). That brief is not legal advice.
