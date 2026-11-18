# Design-partner pilot agreement: outline, not legal advice

> **Outline, not legal advice.** Section headings and what each section should cover. There is no binding language here
> and nothing here is a term anyone has agreed. Counsel drafts the agreement. Bracketed choices are **OPTIONS** for Akash.

- **Checked:** 2026-11-12 (IST). The "DPA clause" column refers to the numbered clauses of the India DPA outline in
  [dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §9. The pilot agreement should attach or incorporate
  that DPA rather than repeat it (**proposal**).
- **Roles (interpretation, from that doc §3):** for meeting content the partner is the Data Fiduciary and MeetOps the
  Data Processor (P1, P5, P6). For optional Hindi-English eval data, MeetOps uses content for its own purpose, so MeetOps
  is a Data Fiduciary for that data and needs its own consent from each speaker (see
  [hinglish-eval-data-protocol.md](hinglish-eval-data-protocol.md) §1).

| #   | Section                            | What it should cover (bullets only)                                                                                                                                                                             | DPA clause           |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | Parties and purpose                | Who the parties are; that this is a free, time-limited design-partner pilot; that feedback is the main exchange                                                                                                 | 1                    |
| 2   | Pilot scope                        | Which teams, meetings and features; meetings the partner excludes (external participants, sensitive topics); Jira/GitHub projects connected; [OPTION: number of seats]                                          | 2                    |
| 3   | Term and timeline                  | Start date, 8-week length ([pilot-success-metrics.md](pilot-success-metrics.md) §2), check-in cadence, early exit by either side                                                                                | 15                   |
| 4   | Fees and incentives                | No fee during the pilot; any post-pilot discount ([icp-and-recruitment.md](icp-and-recruitment.md) §7) [OPTION]; no payment linked to eval data                                                                 | —                    |
| 5   | Roles and data protection          | Partner = Data Fiduciary, MeetOps = Data Processor for meeting content; incorporate the DPA; MeetOps' own account and billing data under its privacy notice                                                     | 1, 3                 |
| 6   | Partner duties on recording        | Recording notice and consent under ADR-020 (all-party, notice by default, explicit consent option, capture stops on revocation); s. 5 notice to participants; no under-18 participants                          | 4, 13                |
| 7   | AI processing                      | Which AI sub-processors process content, at which stage and where; no vendor training on content; paid-tier only for customer data ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §5.1)       | 3, 7, 8              |
| 8   | Security                           | Summary of safeguards; annex of technical measures; what is not built yet (e.g. content PII redaction, provider-side deletion; see [ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §1)          | 5                    |
| 9   | Breach notice                      | MeetOps → partner timeline [OPTION from DPA §4]; contents mapped to Rule 7(2)(b); partner's own duties to the Board and CERT-In; vendor notice terms ([verification-round-3.md](../verification-round-3.md) §4) | 6                    |
| 10  | Sub-processors and location        | List as annex ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §8); change notice [OPTION: days]; processing locations per vendor                                                               | 7, 8                 |
| 11  | Retention and deletion             | Partner's retention setting (ADR-019, 7–365 days); deletion at the end of the pilot unless the partner continues; deletion on request; log retention (Rule 8(3))                                                | 9                    |
| 12  | Data Principal requests            | How MeetOps helps the partner answer access, correction and erasure requests; contact point                                                                                                                     | 10                   |
| 13  | Feedback and usage metrics         | Partner gives interviews ([interview-script.md](interview-script.md)); MeetOps collects counts and ratios only ([pilot-success-metrics.md](pilot-success-metrics.md) §1); no content in reports                 | 3, 11                |
| 14  | Optional eval-data addendum        | Separate, opt-in; per-speaker consent collected by MeetOps; withdrawal at any time; nothing in the pilot depends on it ([hinglish-eval-data-protocol.md](hinglish-eval-data-protocol.md))                       | 3 (purpose limit), 9 |
| 15  | Confidentiality                    | Both sides' confidential information; interview notes without names; no publicity without written permission                                                                                                    | —                    |
| 16  | Intellectual property and feedback | Partner keeps its content; MeetOps may use feedback (not content) to improve the product [OPTION]                                                                                                               | 3                    |
| 17  | Audit and information              | Reasonable information on request; certifications if any; SDF partners excluded ([icp-and-recruitment.md](icp-and-recruitment.md) §5)                                                                           | 12                   |
| 18  | Liability                          | Pilot "as is" position and caps [OPTION]; allocation in light of s. 8(1)                                                                                                                                        | 14                   |
| 19  | Exit                               | Export of tasks and transcripts; deletion confirmation; what survives (confidentiality, log retention)                                                                                                          | 9, 15                |
| 20  | Precedence and governing law       | Order of documents (agreement, DPA, eval addendum); other regimes for partners with foreign participants (e.g. US or EU) in separate annexes                                                                    | 16                   |

## Decisions needed

- **Akash:** seats and scope (2); post-pilot discount (4); breach-notice timeline (9); sub-processor change notice (10);
  feedback rights (16); liability position (18). Counsel drafts the text.
