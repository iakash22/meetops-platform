# GTM brief: India SMB and mid-market (November 2026)

- Checked **2026-11-12 (IST)**. New sources are GT1–GT18 at the end; S…, M…, P… and V… IDs point to the merged #468 and #473 docs ([competitive-landscape.md](competitive-landscape.md), [verification-notes.md](verification-notes.md), [pricing-packaging.md](pricing-packaging.md)).
- **Labels.** Market figures from third parties and our own arithmetic are **estimates**. Prices, plans, targets and the
  launch plan are **proposals**, not decisions. Decisions marked "project-lead decision" with a date are decisions.
- Prices match [pricing-packaging.md](pricing-packaging.md). Legal context is in
  [legal-questions-brief.md](legal-questions-brief.md). That brief and this one are not legal advice.

## 1. Headline

**For Indian software, IT-services and agency teams: turn Hinglish meetings into approved Jira/GitHub work with proof,
captured without a bot, with consent people can see, from ₹799 per recording user per month (proposal).** Incumbent suites
sell AI notes in INR but handle one language per meeting or lack Hindi. AI-notetaker specialists price in USD to Indian
visitors (see §7).

## 2. ICP and personas

**ICP (proposal).** Indian companies with roughly 20–1,000 staff (our working cut-off: SMB 20–200, mid-market 200–1,000)
that:

- build or deliver software: product companies, IT services and agencies, client-delivery teams. These are the README's
  target users ("Software companies, IT agencies, product and client-delivery teams…", `README.md`);
- track work in **Jira or GitHub** (our only task integrations, ADR-007/008);
- run meetings that mix English with Hindi or another Indian language (G6 in [market-gaps.md](market-gaps.md));
- often meet in clients' tenants, where Copilot doesn't work (G9; [S17] in #468);
- pay in INR with a GSTIN and prefer UPI AutoPay or invoices (ADR-017).

| Persona                                  | Role in the deal     | What they need                                                        | What we show                                                                     |
| ---------------------------------------- | -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Engineering manager / tech lead          | Champion, daily user | Action items with the right owner, in Jira/GitHub, no retyping        | Evidence-linked drafts → approve → issue (#468 #1, #6, #7)                       |
| Delivery / project manager (agency)      | Champion             | Follow-through across a client's recurring meetings                   | "Since last meeting" ([spec 02](specs/02-since-last-meeting.md)); cross-org mode |
| Founder / CTO (SMB)                      | Economic buyer       | Low INR price, no lock-in, no surprises for clients                   | INR plans, UPI AutoPay, no-viral guarantee (spec 04)                             |
| IT admin / security or privacy lead (MM) | Gatekeeper           | Control over who records, no bot spreading, retention, DPDP readiness | Admin rollout, consent ledger, retention 7–365 days (ADR-019)                    |
| Finance                                  | Approver             | GST invoice, predictable recurring charge                             | GST invoicing, ≤ ₹15,000 per mandate charge (ADR-017)                            |

## 3. Market size

| Figure                                                                                                                                   | Value                                                                              | Source      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| Udyam + Udyam Assist registrations (all MSMEs, including informal micro)                                                                 | 10,09,96,603 total; Micro 10,03,62,255                                             | [GT1]       |
| Of which **Small** (investment ≤ ₹25 crore and turnover ≤ ₹100 crore) and **Medium** (investment ≤ ₹125 crore and turnover ≤ ₹500 crore) | Small **5,46,035**; Medium **42,092** (5,88,127 together, our sum)                 | [GT1, GT18] |
| MSME registrations by activity (dashboard, 12 Nov 2026)                                                                                  | Services 3,91,70,281; Trading 4,19,65,758; Mfg 1,98,14,263                         | [GT2]       |
| DPIIT-recognised startups                                                                                                                | "more than 2.62 lakh" (Nov 2026); 52% from non-metro cities                        | [GT3]       |
| Developers on GitHub from India                                                                                                          | +5.2 million in 2025; 57.5 million developers in India by 2030 (GitHub projection) | [GT4]       |
| Zoho Corporation, all regions                                                                                                            | >1 million paying customers, >150 million users (Feb 2026)                         | [GT5]       |
| Global AI meeting-assistant market                                                                                                       | **Estimates:** $3.91B (2026) → $9.33B (2030); or +$3.46B 2024–29                   | [M6, M7]    |

Caveats:

- Udyam's MSME size classes use investment caps as well as turnover, not only turnover, and not headcount or software
  use [GT1, GT18]. Official criteria (S.O. 1364(E), 21 March 2025, in force from 1 April 2025): Small — investment ≤ ₹25
  crore and turnover ≤ ₹100 crore; Medium — investment ≤ ₹125 crore and turnover ≤ ₹500 crore. The counts above are a
  ceiling on "registered small and medium businesses", not a count of our buyers. Startups and MSMEs overlap.
- We found **no published figure for India's AI meeting-assistant market**. We don't make one up.
- **Our sizing formula (estimate):** SAM = ICP orgs × recording users per org × price × 12. _Illustration only, with
  assumed inputs:_ 10,000 orgs × 10 recording users × ₹799 × 12 ≈ **₹95.88 crore a year**. The 10,000 and 10 are
  placeholders, not evidence; replace them with pilot and funnel data.

## 4. Buying behaviour and channels

### 4.1 How these buyers pay (evidence)

- Suites localise for India: Google Workspace shows INR, including an introductory ₹864 Standard price for the first 20
  users; Microsoft and Zoom show INR excluding GST [P13, P15, P16](pricing-packaging.md).
- Zoho, the largest India-built suite, accepts "online banking transfers and checks for yearly subscriptions" besides
  cards and PayPal [GT6].
- RBI e-mandates: recurring debits up to ₹15,000 need no extra authentication; larger plans go by invoice (ADR-017 item 3).

### 4.2 Channels (proposal, in priority order)

| Channel                              | Facts (checked 2026-11-12)                                                                                                                                                                                                                                                                                                          | Fit and work for us                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product-led, inside the org only** | —                                                                                                                                                                                                                                                                                                                                   | Self-serve sign-up and a free tier, but growth only through people the admin invites. No emails to external attendees, no auto-join (spec 04 guarantees). This trades viral reach for admin trust; that is the bet.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Google Workspace Marketplace**     | Public listing needs Google's app review; apps must pass **OAuth verification** and use the narrowest scopes. Meet add-ons "must not provide functionality to invite a bot or rely on the presence of a bot" [GT7]. Restricted scopes also need an annual CASA security assessment [GT8]                                            | Botless capture fits the Meet rule. Our Google scopes today are `calendar.events.readonly` and `calendar.calendarlist.readonly` (`packages/integrations/src/calendar.ts`); `calendar.events.readonly` is **sensitive** and neither is **restricted**, so no CASA assessment; whether `calendarlist.readonly` is sensitive is **not verified** (only the Cloud Console shows it). Brand plus sensitive-scope verification take about 2–3 plus up to 10 business days, and unverified apps are capped at 100 new users ([verification-round-2.md](verification-round-2.md) §1, R2-G1–R2-G3). Needs the Google Calendar OAuth client (owner) |
| **Atlassian Marketplace (Jira)**     | Since 17 Sep 2025 only **Forge** apps can be submitted [GT9]. From 1 Jan 2026, eligible Forge apps pay **0%** revenue share up to $1M lifetime Forge revenue; the standard Forge rate is 16% from 1 Apr 2026 and 17% from 1 Oct 2026 [GT10, GT10b]                                                                                  | Our Jira integration is OAuth 3LO, not a Forge app (`packages/integrations/src/jira-oauth.ts`). A 3LO app can get an informational listing only; paid and installable Marketplace listings need a Forge app. Connect support ends 31 Jan 2027 ([verification-round-2.md](verification-round-2.md) §3, R2-A1–R2-A3). Forge effort not estimated yet                                                                                                                                                                                                                                                                                        |
| **Zoho Marketplace**                 | ISVs apply as partners; review covers "functional and security testing, as well as content review"; Zoho handles payment processing [GT11]                                                                                                                                                                                          | No Zoho integration exists in the repo. Zoho Meeting is also a competitor (§7). Later, and only if pilots show Zoho-first buyers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Partners**                         | Zoho says it works with TCS, PwC and Deloitte on solutions for large organisations [GT5]                                                                                                                                                                                                                                            | For mid-market, Google/Zoho resellers and Jira consultancies are the likely partners. Partner terms **not researched**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **GitHub Marketplace**               | Free listings for public apps that integrate beyond sign-in. **Paid** plans need an org-owned app, publisher verification (org 2FA, verified domain), at least 100 installations for a GitHub App, monthly and annual plans priced in **USD**; GitHub keeps 5% ([verification-round-2.md](verification-round-2.md) §2, R2-H1–R2-H8) | Our GitHub App (ADR-007) is the recommended app type. A free listing is possible once the app is public; a paid listing's USD-only pricing doesn't match ADR-017's INR billing                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 5. Pricing in INR (proposal, from pricing-packaging.md §4)

| Tier (proposal) | INR per recording user / month (annual / monthly) | Included capture | Notes                                                                                   |
| --------------- | ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| Free            | ₹0                                                | 5 h              | Consent receipts and one integration with approval                                      |
| Team            | **₹799 / ₹999**                                   | 25 h             | Hindi-English code switching, two-way sync, admin rollout                               |
| Business        | **₹1,499 / ₹1,799**                               | 50 h             | Retention, audit export, SSO when built (ADR-021); Indic routing via Sarvam (see below) |
| Enterprise      | Custom (invoice)                                  | Custom           | DPA, residency if built (#468 #14)                                                      |
| Extra pack      | ₹299 per 10 h                                     | —                | Any paid tier                                                                           |

- **Sarvam (project-lead decision, 2026-11-12):** opt-in, off by default, capped, and **no Sarvam spend until Akash sets a
  budget**. Until then the Business tier offers AssemblyAI code switching only; don't market "Sarvam" or extra Indic
  languages at launch.
- Viewers and approvers are free; charge only people who record (pricing principle 2 in [pricing-packaging.md](pricing-packaging.md) §4).
- One monthly mandate charge covers up to 15 Team users or 8 Business users under ₹15,000; larger monthly orgs move to an
  annual invoice ([pricing-packaging.md](pricing-packaging.md) §4).
- Open: show prices with or without 18% GST ([pricing-packaging.md](pricing-packaging.md) §5 Q2). Competitors show them without GST.

## 6. Compliance messaging (DPDP Act 2023 and Rules 2025)

### 6.1 Status today (from primary sources)

| Item                                                                                             | Status                                                                                                                                                                                                        | Source       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| DPDP Rules, 2025 (G.S.R. 846(E)) and the Act's commencement notification (G.S.R. 843(E))         | Notified **13 Nov 2025**; corrigendum G.S.R. 892(E) dated 11 Dec 2025 in the Gazette, listed by MeitY as published 16 Dec 2025                                                                                | [GT12, GT13] |
| Rule 1(2): Rules 1, 2 and 17–21 (Data Protection Board)                                          | In force from publication                                                                                                                                                                                     | [GT12]       |
| Rule 1(3): Rule 4 (Consent Managers)                                                             | "one year after" publication, i.e. **13 Nov 2026** (our computation)                                                                                                                                          | [GT12]       |
| Rule 1(4): Rules 3, 5–16, 22, 23 (notice, security, breach, erasure, rights, cross-border, etc.) | "eighteen months after" publication, i.e. **13 May 2027** (our computation; matches ADR-019)                                                                                                                  | [GT12]       |
| Government restatement                                                                           | Lok Sabha reply of 12 Aug 2026 restates the 18-month phased timeline; penalties "up to ₹250 crore"                                                                                                            | [GT14]       |
| DPDP (Removal of Difficulties) Order, 2026, S.O. 5458(E), 5 Oct 2026                             | Wording fixes to s. 9(1) and s. 10(2)(c)(ii) only. Read on egazette.gov.in (Gazette Extraordinary No. 5248, 6 Oct 2026); the text matches the third-party copy we read first                                  | [GT15]       |
| Reported Jan 2026 proposal to shorten the 18 months to 12                                        | **Not notified as far as we found.** MeitY's DPDP Rules page lists only the 2025 documents and the Dec 2025 corrigendum [GT13]; the proposal is known from secondary reporting [GT16]. Re-check before launch | [GT13, GT16] |

### 6.2 What the Rules ask that maps to our product

- **Notice (Rule 3):** an itemised description of the personal data, the specific purpose, and a way to "withdraw her
  consent, with the ease of doing so being comparable to that with which such consent was given" [GT12]. This lines up with
  consent receipts and one-click revoke ([spec 03](specs/03-consent-receipts.md)).
- **Security (Rule 6):** safeguards such as "encryption, obfuscation, masking or the use of virtual tokens", and keeping
  logs for one year to detect and investigate unauthorised access [GT12]. ADR-019 already keeps audit logs for at least a year.
- **Breach (Rule 7):** tell the Board without delay and give detailed information within 72 hours; affected people must also be told without delay [GT12].
- **Erasure (Rule 8):** for the classes of Data Fiduciary in the Third Schedule, give at least 48 hours' notice before
  erasure at the end of the retention period [GT12]. Whether MeetOps or its customers fall in those classes is a question
  for counsel.

### 6.3 Messaging rules (proposal)

- **Say:** "Built for India's DPDP rules: consent you can show, revoke in one click, retention you set, deletion you can
  prove." Say each part only once it has shipped (spec 03; #468 #10).
- **Don't say:** "DPDP compliant" or "certified". The README rules out compliance claims without evidence, and ADR-020
  item 7 requires a legal review of the notice and DPA before GA.
- **Don't claim per-participant consent records yet.** The ledger records the signed-in host today. That is a tracked
  feature gap and the backbone of spec 03 (project-lead decision, 2026-11-12).
- **Bot notice and consent default:** ADR-020's "MeetOps Recorder" notice assumes a bot we don't ship. That mismatch goes
  into an **ADR-020 amendment owned by the All Rounder Techy agent**. The consent default is: "explicit consent is on by
  default for all orgs until an org country is stored" (project-lead decision, 2026-11-11, recorded in the ADR-020
  amendment in [PR #472](https://github.com/iakash22/meetops-platform/pull/472)). Marketing copy waits for the bot-notice
  wording.
- Open question for counsel: are customers the Data Fiduciary and MeetOps their Data Processor for meeting data?

## 7. Competitor positioning in India

| Competitor                                | What an India buyer sees                                                                                                                                             | Our angle                                                        | Source                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Google Workspace (Gemini in Meet)         | INR pricing; Gemini in Meet from Standard (₹1,080 list, ₹864 intro); one language per meeting; listed note-taking languages don't include Hindi                      | Hindi-English in one transcript; Jira/GitHub with approval       | [P13](pricing-packaging.md), [V16](verification-notes.md), S16 |
| Microsoft 365 Copilot                     | INR pricing (₹1,745 add-on); no Hindi for work/school accounts; doesn't work in meetings hosted outside the org                                                      | Works on any tab, including clients' meetings; Hindi-English     | [P16](pricing-packaging.md), [V8](verification-notes.md), S17  |
| Zoom (AI Companion / ZoomMate)            | INR pricing (Pro ₹1,240 annual); meeting summary in 33 languages, including Hindi, Bengali, Tamil, Telugu                                                            | Not tied to one platform; evidence-linked tasks into Jira/GitHub | [P15](pricing-packaging.md), V7                                |
| Zoho Meeting                              | Transcripts and "keynotes" in the tier above Standard; Zia keynotes need the customer's own OpenAI key; Zia transcription only in English and six European languages | No key to bring; Indian languages; tasks into Jira/GitHub        | [GT6], [GT17]                                                  |
| AI notetakers (Otter, Fireflies, Fathom…) | USD prices to Indian visitors; Otter has no Hindi; Fathom lists 38 transcript languages including Hindi                                                              | INR and UPI AutoPay; no bot; consent receipts                    | [pricing-packaging.md](pricing-packaging.md) §2, S1, V1        |

Zoho Meeting's INR prices, per host/month billed annually, as rendered from India on 2026-11-12 [GT6]. The page says
"Local taxes (VAT, GST, etc.) will be charged in addition to the prices mentioned." Free is ₹0 (100 participants, 60
minutes per meeting).

| Participants | Standard (has recording) | Professional (adds transcripts and keynotes) |
| ------------ | ------------------------ | -------------------------------------------- |
| 10           | ₹50                      | ₹125                                         |
| 25           | ₹167                     | ₹250                                         |
| 50           | ₹208                     | ₹375                                         |
| 100          | ₹292                     | ₹500                                         |
| 150          | ₹333                     | ₹584                                         |
| 200          | ₹417                     | ₹667                                         |
| 250          | ₹458                     | ₹750                                         |

The page picks the currency by the visitor's location, so re-render before quoting ([verification-round-2.md](verification-round-2.md) §4).

## 8. Launch plan (proposal)

**Gates before any paid launch:** non-free-tier LLM for customer data (`docs/plans/phase-7-notes.md`); P9 billing
(ADR-017, ~60% per [roadmap-plan.md](roadmap-plan.md)); the ADR-020 amendment and item 7 legal review; owner-held keys and
credentials (AssemblyAI, Jira, GitHub App, Google Calendar OAuth client).

| Phase (proposal)          | When (estimate)                   | What                                                                                                 | Exit criterion (proposal)                                 |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 0. Design partners        | Days 0–60, alongside roadmap 0–60 | 5–10 Indian software or agency teams, free, hands-on; Hindi-English eval data with consent (spec 05) | Weekly use by ≥ 3 teams; first approved issues synced     |
| 1. Private beta           | After the gates                   | Team plan in INR via Razorpay; spec 04 guarantees live; consent receipts if spec 03 is done          | Paid conversion from design partners; no consent incident |
| 2. Public self-serve      | After beta                        | Pricing page in INR; Google Workspace Marketplace listing (after OAuth verification)                 | Funnel metrics below measured for 4 weeks                 |
| 3. Marketplaces, partners | Later                             | Atlassian Forge app; Zoho or partner channel only if pilots show demand                              | Channel share of new paid orgs                            |

## 9. Metrics (targets are proposals; set them after design partners)

| Stage      | Metric                                                                           | Why                                                                               |
| ---------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Activation | Org's first approved, synced Jira/GitHub issue within 7 days of sign-up          | Core value moment (README core flow)                                              |
| Value      | Share of AI drafts approved without edits; share edited for owner                | Trust in #1 and #7                                                                |
| Habit      | Recurring meetings with "since last meeting" opened                              | #2 follow-through                                                                 |
| Revenue    | Free → paid conversion; ARPU in INR; net revenue retention                       | Pricing check ([pricing-packaging.md](pricing-packaging.md))                      |
| Trust      | Revocations processed and capture stopped; external emails sent (must be 0)      | Specs 03 and 04 guarantees                                                        |
| Cost       | STT and LLM cost per meeting hour (`AiUsageCounter`); Sarvam spend vs cap        | Margin ([pricing-packaging.md](pricing-packaging.md) §3); lead decision on Sarvam |
| Language   | Share of meetings with Indic languages; error rate on the Hindi-English eval set | Spec 05                                                                           |

## 10. Risks

| Risk                                                                                                                     | Mitigation                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Suites bundle AI notes into plans buyers already pay for (Google, Microsoft, Zoom)                                       | Sell the job they don't do: approved Jira/GitHub work and Hindi-English; price below the bundles                    |
| No-viral rule slows product-led growth                                                                                   | Accept it; grow through admins, marketplaces and partners                                                           |
| Compliance claims run ahead of the product                                                                               | Messaging rules in §6.3; legal review before GA                                                                     |
| DPDP timeline changes (e.g. the reported 12-month proposal)                                                              | Re-check MeitY and the Gazette before launch; build to 13 May 2027 or earlier                                       |
| Indic quality or cost: Sarvam is far costlier per hour than AssemblyAI ([pricing-packaging.md](pricing-packaging.md) §3) | Sarvam off by default and capped, no spend without a budget (lead decision)                                         |
| Free-tier LLM can't process customer data                                                                                | Gate paid launch on an approved provider                                                                            |
| Marketplace reviews and a Forge rebuild take longer than planned                                                         | Direct sales and self-serve first; marketplaces in phase 2–3                                                        |
| Indian agencies serve US clients, so US recording and BIPA law can apply                                                 | Cross-org mode with stricter defaults; legal brief questions ([legal-questions-brief.md](legal-questions-brief.md)) |

## 11. Open questions for Akash

1. Confirm the ICP cut (20–1,000 staff, Jira/GitHub users) or narrow it to agencies first.
2. Sarvam budget, if any, and the cap (lead decision: no spend until set).
3. GST-inclusive or exclusive INR prices.
4. Which channel after self-serve: Google Workspace Marketplace or an Atlassian Forge app?
5. Design-partner terms (free period, data use for the eval set with consent).

## Sources (fetched 2026-11-12 IST)

| ID    | URL                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GT1   | https://udyamregistration.gov.in/Udyam_User/Udyam_Dashboard.aspx (facts dated 11/11/2026 10:30 AM; MSME definitions)                                                                                                               |
| GT2   | https://dashboard.msme.gov.in/ (as on 12-11-2026)                                                                                                                                                                                  |
| GT3   | https://www.pib.gov.in/PressNoteDetails.aspx?ModuleId=3&NoteId=160746&id=160746&lang=1&reg=5 (PIB, 9 Nov 2026)                                                                                                                     |
| GT4   | https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/                                                                                                       |
| GT5   | https://www.zoho.com/news/zoho-corporation-marks-30-years-now-supports-over-one-million-organisations.html (18 Feb 2026)                                                                                                           |
| GT6   | https://www.zoho.com/meeting/pricing.html                                                                                                                                                                                          |
| GT7   | https://developers.google.com/workspace/marketplace/about-app-review (last updated 2026-09-03 UTC)                                                                                                                                 |
| GT8   | https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification and https://support.google.com/cloud/answer/13464325 (both fetched 2026-11-12; R2-G4, R2-G2 in verification-round-2.md) |
| GT9   | https://developer.atlassian.com/platform/marketplace/listing-forge-successor-to-connect-apps/                                                                                                                                      |
| GT10  | https://www.atlassian.com/blog/development/updates-to-marketplace-revenue-share-2026                                                                                                                                               |
| GT10b | https://www.atlassian.com/blog/development/extended-timelines-for-marketplace-revenue-share-changes (3 Nov 2025) and https://developer.atlassian.com/platform/marketplace/pricing-payment-and-billing/                             |
| GT11  | https://www.zoho.com/marketplace/become-a-partner.html                                                                                                                                                                             |
| GT12  | https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf (DPDP Rules, 2025, G.S.R. 846(E), Gazette text)                                                                                               |
| GT13  | https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa (document list) and the G.S.R. 843(E) PDF linked there                                                                 |
| GT14  | https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AU3943_458sox.pdf (Lok Sabha unstarred Q 3943, 12 Aug 2026)                                                                                                           |
| GT15  | https://egazette.gov.in/WriteReadData/2026/276885.pdf (Gazette CG-DL-E-07102026-276885, read 2026-11-12); first read from a third-party copy at avantiscdnprodstorage.blob.core.windows.net                                        |
| GT16  | https://chambers.com/articles/meity-plans-to-cut-short-dpdp-compliance-timeline-and-notify-cross-border-restrictions-for-sdfs (secondary; search summary)                                                                          |
| GT17  | https://help.zoho.com/portal/en/kb/meeting/user-guide/integrations/zia/articles/zia-ai                                                                                                                                             |
| GT18  | https://egazette.gov.in/writeReadData/2025/261838.pdf (Gazette of India, Extraordinary, S.O. 1364(E), 21 March 2025; MSME investment and turnover limits, in force 1 April 2025)                                                   |
