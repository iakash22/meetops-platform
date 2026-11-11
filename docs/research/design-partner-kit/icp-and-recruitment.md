# Design partners: ICP and recruitment criteria

- **Checked:** 2026-11-12 (IST). This builds on the ICP and personas in
  [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §2 and the phase 0 plan in §8. Everything here is a
  **proposal** unless a source is cited.
- **No outreach.** This doc names no real people or target companies. Segments and archetypes only.

## 1. What a design partner is for

Phase 0 of the launch plan is "5–10 Indian software or agency teams, free, hands-on; Hindi-English eval data with
consent (spec 05)", with the exit criterion "weekly use by ≥ 3 teams; first approved issues synced"
([gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §8, itself a proposal). Design partners should help us:

1. Measure baselines for the spec success metrics, which all say "baseline to be measured" or "measure first"
   ([specs/01](../specs/01-commitment-graded-action-items.md) §6, [specs/05](../specs/05-mixed-language-indic-transcription.md) §7).
2. Test the P0 bets against real meetings: evidence-first action items (#1), follow-through (#2), consent receipts (#3),
   no-viral growth (#4), code-switching (#5), approval-gated Jira/GitHub sync (#6), routing and assignee suggestion (#7)
   ([feature-proposals.md](../feature-proposals.md)).
3. Supply consented Hindi-English eval data, but only under [hinglish-eval-data-protocol.md](hinglish-eval-data-protocol.md).
   Eval data is optional for a partner. Product use doesn't depend on it.

## 2. ICP by segment (proposal)

All segments share the base ICP: Indian company, roughly 20–1,000 staff (SMB 20–200, mid-market 200–1,000), tracks work
in Jira or GitHub, pays in INR with a GSTIN ([gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §2).

| Segment                          | Archetype                                                                    | Why they fit                                                          | Gaps most tested                               | Watch for                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Software product / SaaS          | Product company with its own engineering team and recurring sprint rituals   | Action items map straight to Jira/GitHub issues; daily users          | G4, G5 (#1, #2, #6, #7)                        | Already bundled AI notes from their suite; needs a reason to switch                    |
| IT services / outsourcing        | Delivery teams working for several clients, often in the clients' tenants    | Cross-org meetings, client-facing follow-through, consent sensitivity | G1, G9, G5 (#2, #3, cross-org mode)            | Client contracts may forbid third-party recording; US clients bring US law             |
| Digital / product agencies       | Small client-delivery teams running weekly client calls                      | Follow-through across a client's recurring meetings                   | G5, G9, G1 (#2, #3)                            | Many short projects; a partner team may churn when a client contract ends              |
| Mid-market in-house tech teams   | Engineering function inside a non-software company, with an IT/security lead | Admin control, rollout and DPDP readiness are buying criteria         | G2, G7, G8 (#4, retention, residency question) | Longer security review; may need a DPA before any pilot (see pilot outline)            |
| Any of the above, mixed-language | Teams whose meetings mix English with Hindi or another Indian language       | Supplies the code-switching signal and, with consent, eval data       | G6 (#5, spec 05)                               | Only Hindi-English is in scope for eval data now; other languages are observation only |

Gap and bet IDs: G1–G10 in [market-gaps.md](../market-gaps.md) §1; #1–#8 in [feature-proposals.md](../feature-proposals.md).

## 3. ICP by role (proposal)

Roles follow the personas in [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §2. A partner team needs at
least the first three.

| Role                                         | Must be true                                                                        | What we need from them                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Champion (engineering, delivery or PM lead)  | Runs at least 2 recurring meetings a week that produce tasks; can invite their team | Weekly use, 3 interviews (§ "Pilot" in the script), review of AI drafts         |
| Economic buyer (founder, CTO, function head) | Can say whether they would pay in INR after the pilot, and on what terms            | Kick-off and close-out interviews; pricing reaction (no price commitment asked) |
| IT / security / privacy gatekeeper           | Can approve a pilot tool, set who records, and review our DPA outline               | One security interview; admin settings feedback; DPA and consent review         |
| End users (meeting participants)             | Attend the recorded meetings; adults (18+) only if they also join eval data         | Notice of recording per ADR-020; optional short feedback; optional eval consent |

## 4. Qualification (proposal)

A team qualifies if all of these are true:

1. Fits a segment in §2 and the base ICP.
2. Uses Jira or GitHub for the work discussed in meetings (our only task integrations, ADR-007/008).
3. Has at least one recurring meeting a week with 3+ people where tasks are agreed.
4. Has a champion and an economic buyer who agree to the interview cadence in [interview-script.md](interview-script.md).
5. The IT/security gatekeeper (or the founder, in SMB) accepts the pilot terms and the ADR-020 consent model: all-party
   notice by default, explicit consent where the org asks for it, and capture stops on revocation
   ([ADR-020](../../15-decisions/ADR-020-recording-consent.md) decisions 1–5).
6. Can name which meetings include external participants, so those can be skipped or handled under the cross-org rules
   (ADR-020 decision 4).

## 5. Disqualifiers (proposal)

- Wants covert or one-party recording. ADR-020 has "no one-party mode" (decision 1).
- Meetings routinely include under-18s (students, interns under 18). DPDP s. 9 requires verifiable parental consent, and
  the eval protocol excludes children entirely ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §6).
- Regulated content we can't yet protect: health, card or payment data, or clients whose contracts bar third-party AI
  processing. The AI pipeline has no content PII redaction today
  ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §1).
- Requires India-only processing as a hard condition. Our default STT runs in the US or EU only and the default LLM has
  no India region ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §3).
- Would be a Significant Data Fiduciary customer needing Rule 13 support we can't give yet
  ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §7).
- Expects us to sync to a tracker other than Jira or GitHub during the pilot.
- A direct competitor, or a team that wants the pilot mainly to benchmark us.

## 6. Cohort size and mix (proposal)

- **Size:** 6–8 teams, within the phase 0 range of 5–10. Fewer than 5 gives too little spread across segments, and more
  than 10 is more than a small team can support hands-on (**estimate**, not measured).
- **Mix:** at least 2 software/SaaS, 2 IT services or agency, and 1 mid-market in-house team. At least 3 teams with
  Hindi-English meetings, of which at least 2 opt into eval data.
- **Size spread:** at least 2 SMB (20–200 staff) and at least 2 mid-market (200–1,000).
- **Length:** 8 weeks per team. 2 weeks of baseline (§ baseline in [pilot-success-metrics.md](pilot-success-metrics.md)),
  then 6 weeks of use.
- **Gates first:** customer data must not go to a free-tier LLM ([gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md)
  §8 gates). Design partners are customers for this rule, so the paid-tier decision
  ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §5.1) must come before any partner meeting is processed.

## 7. Incentives (all proposals, none decided)

- Free use of the planned Team or Business tier during the pilot, and for 3 months after it.
- An introductory discount on the first paid year in INR, against the proposed tier prices in
  [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §5. The size of the discount is a **Decision needed** (Akash).
- Early access to P0 features, and a named feedback channel with the product team.
- Optional public reference or case study only with written permission at the end; never a condition of the pilot.
- **No payment or gift for eval data.** Consent to eval data must be "free" and "unconditional" (DPDP s. 6(1)), and
  nothing in the pilot may depend on it. Whether a small thank-you to individuals is acceptable is a counsel question
  (see [hinglish-eval-data-protocol.md](hinglish-eval-data-protocol.md) §10).

## 8. Recruitment channels (generic; proposal)

No contact has been made. These describe where design partners are usually found, not specific targets.

| Channel (generic)                                              | Fit                                 | Rule                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Our own sign-ups and waitlist                                  | Self-selected, already interested   | Contact only people who asked to hear from us; record the opt-in                                         |
| The founders' and team's existing professional networks        | Warm, fast                          | Introductions only with the introducer's consent; no scraped lists                                       |
| Engineering-manager and founder communities and meetups        | Champions in all segments           | Follow each community's rules on promotion; post only where allowed                                      |
| Jira/GitHub consultancies and workspace resellers (archetypes) | Reach mid-market and IT services    | Partner terms not researched ([gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §4.2)          |
| Startup programmes and incubators (archetype)                  | SMB software teams                  | Through the programme's own process                                                                      |
| Content that answers the gaps (G4, G6, G1)                     | Inbound from teams with the problem | No claims beyond the messaging rules in [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §6.3 |

Rules for every channel (proposal): no scraping of contact data; no bulk unsolicited email; contact only work addresses
that were given to us; one follow-up at most; keep a log of who agreed to be contacted and when. Our own outreach data is
personal data for which MeetOps is a Data Fiduciary (P4 in [dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §3).

## 9. Decisions needed

- **Akash:** cohort size and segment mix (§6); incentive terms and discount size (§7); which channels to use (§8);
  whether partners can start before the paid-LLM gate is cleared (recommended: no).
