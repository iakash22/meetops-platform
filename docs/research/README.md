# Product research

Market and competitor research for MeetOps. These docs are not specs, and nothing here is a decision until it's taken
through an ADR (`docs/15-decisions/`) or a plan (`docs/plans/`).

| Doc                                                          | What it covers                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [competitive-landscape.md](competitive-landscape.md)         | 19 competitors: capture, platforms, languages, AI, integrations, privacy, pricing, segment; sources                                        |
| [market-gaps.md](market-gaps.md)                             | Unmet needs with evidence, market-size estimates, trends                                                                                   |
| [feature-proposals.md](feature-proposals.md)                 | 24 ranked proposals with fit to repo modules and ADRs                                                                                      |
| [roadmap-plan.md](roadmap-plan.md)                           | 30/60/90-day plan mapped to phases and teams, with dependencies and risks                                                                  |
| [verification-notes.md](verification-notes.md)               | Resolves the "not verified" items in the docs above with primary sources, and what each one corrects                                       |
| [specs/](specs/README.md)                                    | Deep-dive specs for the five P0 proposals, with per-team effort estimates                                                                  |
| [pricing-packaging.md](pricing-packaging.md)                 | Competitor price benchmark (USD and INR) and **proposed** MeetOps tiers                                                                    |
| [legal-questions-brief.md](legal-questions-brief.md)         | Questions for counsel on BIPA, EU AI Act Art. 50 and ADR-020 (not legal advice)                                                            |
| [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md)                 | One page: top 10 bets, why we win, what to build first                                                                                     |
| [gtm-india-smb-midmarket.md](gtm-india-smb-midmarket.md)     | India SMB and mid-market GTM: ICP, market size, channels, INR pricing, DPDP messaging                                                      |
| [verification-round-2.md](verification-round-2.md)           | Google scope classes, GitHub and Atlassian marketplace rules, Zoho INR prices, DPDP timeline, India size                                   |
| [ai-provider-due-diligence.md](ai-provider-due-diligence.md) | Gemini, Vertex AI, AssemblyAI, Azure OpenAI, OpenAI API and Sarvam: training, retention, regions, DPAs, prices, cost estimates and options |

Conventions:

- Every vendor fact cites a URL fetched on the "Checked" date at the top of the doc. Re-check before quoting it outside
  the team, because prices and features change often.
- Third-party projections and our own reasoning are labelled **estimate**.
- "Not verified" means we couldn't read it from a fetched page. It doesn't mean the feature is missing.
