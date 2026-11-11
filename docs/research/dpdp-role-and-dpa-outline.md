# DPDP role analysis and India DPA outline (outline, not legal advice)

> **Not legal advice.** This is product research for Akash and for outside counsel. It quotes the Digital Personal Data
> Protection Act, 2023 and the DPDP Rules, 2025 as read from official copies on **2026-11-12 (IST)**, applies them to
> how MeetOps works in the repo at `integration/phase-1` `80eb5c2b`, and lists questions for counsel. Every reading of the
> law applied to MeetOps is labelled **Interpretation**. The DPA part (§9) is an **outline, not legal advice**: headings
> and what each clause must cover, with no binding wording. Nothing here is decided until it goes through counsel and an
> ADR.

## 1. Instruments and dates

| Instrument                                                                 | What it does                                                                                                                                                                                                                                                                       | Source |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| DPDP Act, 2023 (No. 22 of 2023), assent 11 Aug 2023                        | The Act. Most operative sections wait for G.S.R. 843(E).                                                                                                                                                                                                                           | [D1]   |
| **G.S.R. 843(E)**, MeitY notification dated 13 Nov 2025                    | **Commencement of the Act**, not the Rules: s. 1(2), s. 2, ss. 18–26, 35, 38–43, 44(1), (3) on publication; s. 6(9) and s. 27(1)(d) one year later; ss. 3–5, 6(1)–(8) and (10), 7–17, 27 (except 27(1)(d)), 28–34, 36, 37 and 44(2) "eighteen months from the date of publication" | [D2]   |
| **G.S.R. 846(E)**, the DPDP Rules, 2025, dated 13 Nov 2025                 | The Rules. Rule 1: Rules 1, 2 and 17–21 on publication; Rule 4 one year after; Rules 3, 5–16, 22 and 23 eighteen months after. Gazette Extraordinary No. 760, "Thursday, November 13, 2025"; e-Gazette ID CG-DL-E-14112025-267650                                                  | [D3]   |
| S.O. 5458(E), DPDP (Removal of Difficulties) Order, 2026, dated 5 Oct 2026 | Wording fixes only: in s. 9(1) "child or a person with disability" becomes "child or of a person with disability"; in s. 10(2)(c)(ii) "audit" becomes "data audit". No change to dates                                                                                             | [D4]   |
| CERT-In Directions No. 20(3)/2022-CERT-In, 28 Apr 2022 (IT Act s. 70B(6))  | A separate law: cyber incidents reported to CERT-In within 6 hours; ICT logs kept 180 days in India                                                                                                                                                                                | [D5]   |

**Correction to the brief.** The task named the Rules "G.S.R. 843(E)". In the Gazette, **843(E) is the Act's
commencement notification and the Rules are G.S.R. 846(E)** [D2, D3]. Both are dated 13 Nov 2025.

**Dates (computed by us from "one year" / "eighteen months from the date of publication"; not stated as calendar dates in
the instruments):**

- **13 Nov 2026**: s. 6(9) (Consent Manager registration), s. 27(1)(d) and Rule 4 (Consent Managers) start.
- **13 May 2027**: the 18-month deadline. Fiduciary duties (ss. 4–10, 16, 17), Board powers and penalties (ss. 27–34),
  and Rules 3, 5–16 (notice, security, breach intimation, retention, children, SDF, rights, transfers) start.
- Caveat: the Gazette issue is dated 13 Nov 2025, but the e-Gazette ID and the digital signature on G.S.R. 843(E) read
  14 Nov 2025 [D2, D3]. If "publication" meant 14 Nov, the dates would move one day. Question for counsel (§10).
- No official instrument shortening the 18 months was found (see [verification-round-2.md](verification-round-2.md) §5).

## 2. The statutory tests

- **Data Fiduciary**: "any person who alone or in conjunction with other persons determines the purpose and means of
  processing of personal data" (s. 2(i)) [D1].
- **Data Processor**: "any person who processes personal data on behalf of a Data Fiduciary" (s. 2(k)) [D1].
- **Data Principal** includes the parents or lawful guardian of a child (s. 2(j)); a **child** is under 18 (s. 2(f))
  [D1].
- **Who carries the duties.** The Fiduciary is responsible "irrespective of any agreement to the contrary" for
  processing done "by it or on its behalf by a Data Processor" (s. 8(1)); it may use a Processor "only under a valid
  contract" (s. 8(2)); it must protect data including processing by its Processor (s. 8(5)); notify breaches (s. 8(6));
  and "cause its Data Processor to erase" data (s. 8(7)(b)) and to cease processing after consent is withdrawn (s. 6(6))
  [D1]. The Act puts no direct duties on a Processor; they reach it through the contract.
- **Scope.** The Act covers digital personal data in India and processing outside India "in connection with any activity
  related to offering of goods or services to Data Principals within the territory of India" (s. 3(b)) [D1]. s. 17(1)(d)
  disapplies Chapter II (except s. 8(1) and (5)), Chapter III and s. 16 where data of Data Principals outside India is
  processed in India under a contract with a person outside India [D1].

## 3. Fiduciary or Processor, per processing purpose (**Interpretation**)

| #   | Purpose and data                                                                                                                                                                                                                  | Who decides purpose and means                                                                                                                                                                             | Our reading                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Customer meeting content** for B2B customers: recordings, chunks, transcripts, diarized speaker labels, summaries, action items, embeddings (pipeline S1–S4 in [ai-provider-due-diligence.md](ai-provider-due-diligence.md) §1) | The customer org decides which meetings are recorded, why, who can see results and how long they are kept (retention 7–365 days, ADR-019; consent mode, ADR-020). MeetOps supplies the means as a product | **Customer = Data Fiduciary; MeetOps = Data Processor**, provided MeetOps processes content only on the customer's instructions. This matches ADR-019 L18 ("For meeting content, MeetOps is mostly the processor; the customer org is the Data Fiduciary"). The role could shift towards Fiduciary (alone or "in conjunction", s. 2(i)) for any use of content for MeetOps' own purposes: model training or benchmarking, cross-customer analytics, marketing. Letting an AI vendor train on content (AssemblyAI ToS §4.3(b), see #489) is such a choice |
| P2  | **Our own account data**: users' names, emails, password hashes, MFA, sessions, IPs, coarse location (ADR-014, Proposed), security and audit logs                                                                                 | MeetOps decides how accounts, authentication and security monitoring work                                                                                                                                 | **MeetOps = Data Fiduciary.** Where an org admin invites members, the org supplies the data, but authentication, fraud and security processing are MeetOps' own purposes                                                                                                                                                                                                                                                                                                                                                                                 |
| P3  | **Billing**: billing contacts, invoices, GST details, payment events (Razorpay, ADR-017 Accepted; no billing code yet)                                                                                                            | MeetOps                                                                                                                                                                                                   | **MeetOps = Data Fiduciary.** Razorpay's own role (processor for us, or its own Fiduciary for payment data) is for counsel                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P4  | **Our analytics and metering**: usage counters (`AiUsageCounter`), product telemetry, support tickets, sales and marketing contacts                                                                                               | MeetOps                                                                                                                                                                                                   | **MeetOps = Data Fiduciary.** No third-party product-analytics SDK was found in `apps/` or `packages/` (search for posthog, mixpanel, amplitude, gtag, @sentry). Per-org usage metering for billing is P3/P4, not P1                                                                                                                                                                                                                                                                                                                                     |
| P5  | **Participants who never signed up**: their voice, name, words and speaker label inside a customer's meeting                                                                                                                      | The customer (host) decides to record; ADR-020 makes the host attest notice or consent (`consent_attestations`)                                                                                           | **Same as P1: customer = Fiduciary, MeetOps = Processor.** The s. 5 notice and the s. 4 ground (consent, or a s. 7 legitimate use) are the customer's duty; MeetOps provides the notice tooling (recorder name, chat notice, indicator, ADR-020 decision 2). If MeetOps contacts such people for its own ends (for example growth invites), it becomes a Fiduciary for that contact; the proposed spec 04 (no-viral-growth guarantee) says MeetOps won't email, message or invite anyone outside the org                                                 |
| P6  | **Processing logs** Rule 8(3) requires the Fiduciary to keep for at least one year, including logs of processing "on its behalf by a Data Processor"                                                                              | The customer, for P1                                                                                                                                                                                      | **MeetOps keeps them as Processor for the customer**, so the DPA must say so (Rule 8(3) illustration, Case 2: the Fiduciary must ensure its cloud processor keeps data and logs a year) [D3]                                                                                                                                                                                                                                                                                                                                                             |
| P7  | **Data of people outside India** processed for customers outside India                                                                                                                                                            | The foreign customer                                                                                                                                                                                      | **s. 17(1)(d) may disapply most of Chapter II, Chapter III and s. 16**, but not s. 8(1) and 8(5). Whether it applies to a SaaS processor in India is for counsel                                                                                                                                                                                                                                                                                                                                                                                         |

**Conclusion (Interpretation).** MeetOps is a **Data Processor** for customer meeting content, including the data of
participants who never signed up (P1, P5, P6), and a **Data Fiduciary** for its own account, security, billing,
analytics, support and marketing data (P2–P4). The Processor role holds only if the contract limits MeetOps to the
customer's instructions and MeetOps (and its AI sub-processors) don't use content for their own purposes. Two facts from
the repo matter: the default AI providers are labelled free tier in `packages/ai-core/src/bootstrap.ts` L50 and L55, and
AssemblyAI's free plan can't opt out of training (#489 §2.3).

## 4. Breach intimation

**What the Rules require of the Fiduciary (Rule 7, from 13 May 2027)** [D3]:

| To                           | When                                                                                                            | What                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each affected Data Principal | "without delay", "to the best of its knowledge", via her user account or a registered mode (Rule 7(1))          | (a) nature, extent, timing; (b) likely consequences for her; (c) mitigation measures; (d) safety steps she can take; (e) business contact of a person who can answer                        |
| The Board, first report      | "without delay" (Rule 7(2)(a))                                                                                  | Description: nature, extent, timing and location, likely impact                                                                                                                             |
| The Board, full report       | "within seventy-two hours of becoming aware", or longer if the Board allows on a written request (Rule 7(2)(b)) | (i) updated details; (ii) facts, circumstances and reasons; (iii) mitigation; (iv) findings on who caused it; (v) remedial measures; (vi) report on the intimations sent to Data Principals |

- "Personal data breach" is any unauthorised processing or accidental disclosure, acquisition, sharing, use,
  alteration, destruction or loss of access that compromises confidentiality, integrity or availability (s. 2(u)) [D1].
- Penalty ceilings (Schedule, s. 33): failing reasonable security safeguards (s. 8(5)) up to ₹250 crore; failing to
  notify the Board or Data Principals (s. 8(6)) up to ₹200 crore [D1].
- **Separate law.** CERT-In Directions require "any service provider, intermediary, data centre, body corporate" to
  report listed cyber incidents to CERT-In "within 6 hours of noticing" them [D5]. **Interpretation:** this applies to
  MeetOps directly, whatever its DPDP role.

**What a Processor must pass up the chain (Interpretation; these are contract terms, not statutory duties on
MeetOps):**

- Notice to the customer fast enough for the customer to act "without delay" and file the 72-hour report. The timeline
  is a commercial choice: **OPTION A** a fixed number of hours (for example 24 h, leaving the customer 48 h);
  **OPTION B** "without undue delay" with an hours cap; **OPTION C** tiered (initial notice, then updates). Akash and
  counsel decide.
- Content mapped to Rule 7(2)(b)(i)–(vi), so the customer can reuse it, plus the list of affected customer users and
  participants where known (for Rule 7(1)).
- Cooperation, preservation of logs (Rule 6(1)(c), (e)), and no notice to the customer's Data Principals or the Board on
  the customer's behalf unless instructed.
- The same duty flowed down to each sub-processor (§8). The AI vendors' own breach-notice terms were not reviewed here.

## 5. Cross-border transfer (s. 16, Rule 15)

- s. 16(1): the Central Government "may, by notification, restrict the transfer of personal data by a Data Fiduciary for
  processing to such country or territory outside India as may be so notified". s. 16(2) keeps any stricter Indian law
  (for example sector rules) [D1]. This is a negative list: transfer is allowed unless restricted.
- Rule 15: transfers are allowed subject to the Fiduciary meeting requirements the Government may set "by general or
  special order" about making the data available to a foreign State or entities under its control [D3].
- Rule 13(4): a Significant Data Fiduciary must keep Government-specified personal data and its traffic data in India
  [D3].
- Status: we found **no s. 16 notification and no Rule 15 order**. This rests on secondary trackers [D6, D7], not an
  exhaustive Gazette search, so it is "none found".
- **Interpretation for MeetOps.** For P1 the customer is the Fiduciary making the transfer, through MeetOps' choice of
  sub-processors. Today's default route sends audio to AssemblyAI (US by default; EU optional; no India region) and
  transcripts to the Gemini API, which may store or cache data "in any country" (#489 §2.1, §2.3). The DPA must list
  locations per sub-processor and let the customer react to changes. A Vertex AI Mumbai or Sarvam route (options in #489
  §5) would keep more data in India.

## 6. Children's data (s. 9, Rules 10–12)

- s. 9(1): before processing any personal data of a child, obtain "verifiable consent of the parent" in the prescribed
  manner; S.O. 5458(E) fixed the wording so the clause reads "child or of a person with disability" [D1, D4]. Rule 10 sets due diligence that the parent is an identifiable adult, using
  reliable identity and age details held by the Fiduciary or a virtual token from an authorised entity (including
  DigiLocker) [D3].
- s. 9(2): no processing "likely to cause any detrimental effect on the well-being of a child". s. 9(3): no "tracking or
  behavioural monitoring of children or targeted advertising directed at children" [D1].
- Rule 12 and the Fourth Schedule exempt s. 9(1) and (3) for some classes and purposes, each with conditions. Part A
  includes educational institutions, limited to "tracking and behavioural monitoring" for their educational activities or
  children's safety; Part B includes confirming "that the Data Principal is not a child" [D3].
- Penalty ceiling for s. 9 breaches: up to ₹200 crore (Schedule item 3) [D1].

**What this means for meetings that include under-18s (Interpretation):**

- For P1 the duty to get verifiable parental consent sits with the customer as Fiduciary. A participant's speech in a
  recorded meeting is personal data, so a meeting with a 16-year-old intern, student or family member is in scope.
- MeetOps as Processor should give customers the tools: an org setting or per-meeting flag that minors may attend; the
  ADR-020 option to skip meetings with external participants; easy deletion of a meeting; and a way to record that
  consent came from a parent.
- Features that score or profile individual speakers (talk time, sentiment, engagement) may be "behavioural monitoring"
  if used on children. Counsel should say whether diarization alone is.
- For P2, MeetOps' own Terms should require account holders to be adults; Part B item 6 allows the processing needed to
  confirm a user is not a child [D3].
- Edtech customers may rely on the Part A educational-institution exemption only within its stated condition.

## 7. Significant Data Fiduciary (s. 10, Rule 13)

- The Government may notify any Fiduciary or class as an SDF based on volume and sensitivity of data, risk to Data
  Principals' rights, sovereignty, electoral democracy, security of the State and public order (s. 10(1)) [D1].
- An SDF must appoint a Data Protection Officer based in India, appoint an independent data auditor, and do periodic DPIAs
  and audits (s. 10(2)) [D1, D4]. Rule 13 adds an annual DPIA and audit with a report to the Board, due diligence that
  "algorithmic software" does not risk Data Principals' rights, and localisation of data the Government specifies [D3].
  Penalty ceiling: ₹150 crore (Schedule item 4) [D1].
- We found no SDF notification (secondary tracker [D7]).
- **Interpretation.** MeetOps is unlikely to be notified soon, but meeting recordings are sensitive and could grow in
  volume. The nearer effect is that SDF customers (banks, large platforms) will push SDF duties down to MeetOps by
  contract: audit and DPIA support, evidence on AI features (Rule 13(3)), and India-only storage of specified data.

## 8. Sub-processor list (draft for the DPA annex)

"In code today" means the default path at `80eb5c2b`. There is no production deployment: hosting is "not chosen yet"
(`docs/13-ops/README.md` L3). No other speech or AI vendors are listed here.

| Sub-processor                                             | Purpose                                               | Data                                      | Location (from #489 or repo)                         | Status                                                                                      | Repo evidence                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| AssemblyAI                                                | Batch speech-to-text with diarization (S1)            | Audio chunks, transcripts, speaker labels | US by default; EU endpoint optional; no India region | **In code today (default STT)**                                                             | `apps/worker/src/ai/providers/assemblyai.ts`; `packages/ai-core/src/bootstrap.ts` L53–L56               |
| Google (Gemini API)                                       | Summary and action items (S2, S3)                     | Transcripts, summaries, action items      | May be stored or cached "in any country"             | **In code today (default LLM)**; labelled `tier: 'free'`, which must not take customer data | `apps/worker/src/ai/providers/gemini.ts`; `bootstrap.ts` L46–L51                                        |
| OpenAI (API)                                              | LLM (S2, S3); embeddings possible                     | Transcripts, summaries                    | US default; India storage only by sales approval     | **In code, off by default** (`OPENAI_ENABLED` defaults false)                               | `bootstrap.ts` L68–L72; `packages/ai-core/src/env.ts` L30                                               |
| Google (Vertex AI)                                        | LLM, embeddings                                       | Transcripts, summaries                    | Mumbai (`asia-south1`) available for some models     | **Option only** (no adapter)                                                                | #489 §5.1                                                                                               |
| Microsoft (Azure OpenAI)                                  | LLM, embeddings, diarized STT                         | Transcripts, audio                        | Regional deployments; India model list not verified  | **Option only** (no adapter)                                                                | #489 §2.4                                                                                               |
| Sarvam                                                    | Indic code-mixed STT (S1), LLM                        | Audio, transcripts                        | India (Azure Central India)                          | **Option only** (proposed in spec 05; no adapter)                                           | `docs/research/specs/05-mixed-language-indic-transcription.md`                                          |
| Object storage: Cloudflare R2 or AWS S3 (or `neon`)       | Media, chunks, exports                                | Recordings and derived files              | Depends on bucket region (not chosen)                | **In code, provider not chosen** (MinIO fork is dev only)                                   | `packages/storage/src/config.ts` L48; `infra/docs/object-storage-prod.md`                               |
| Hosting (compute, Postgres with pgvector, Redis)          | App, database, queues                                 | All of the above                          | Not chosen                                           | **Not chosen**; self-hosted containers in compose today                                     | `docs/13-ops/README.md` L3; `infra/compose/compose.dev.yml` L11, L31                                    |
| AWS KMS and Secrets Manager                               | Key wrapping, platform secrets                        | Wrapped keys; no meeting content          | `ap-south-1` (Mumbai)                                | **Decided (ADR-016 Accepted), not built** (no KMS client in code)                           | `docs/15-decisions/ADR-016-secret-manager-kms.md` §Decision 1                                           |
| Cloudflare (edge proxy)                                   | TLS, CDN, client-IP header                            | Request metadata, IPs                     | Edge, nearest data centre                            | **Supported by config** (`BEHIND_CLOUDFLARE`)                                               | `packages/config/src/client-ip.ts` L11                                                                  |
| Resend (or an SMTP provider)                              | Transactional email                                   | Recipient emails, message text            | Not checked                                          | **In code, chosen by `EMAIL_PROVIDER`**; Gmail SMTP refused in production                   | `packages/notifications/src/resend.ts` L17; `packages/notifications/src/config.ts` L13–L49; ADR-013 L28 |
| Expo Push; Web Push services (Google FCM, Mozilla, Apple) | Push notifications                                    | Device tokens; generic text only          | Vendor-run                                           | **In code**; push text is fixed ("You have a new notification"), never meeting content      | `packages/contracts/src/api/notifications.ts` L36–L47                                                   |
| Razorpay                                                  | Subscriptions and payments (P3, MeetOps as Fiduciary) | Billing contacts, payment events          | India                                                | **Decided (ADR-017 Accepted), not built**                                                   | `docs/15-decisions/ADR-017-billing-provider.md`                                                         |

Not sub-processors on this reading (**Interpretation**):

- Local Ollama and faster-whisper run on our own infrastructure (`bootstrap.ts` L57–L66).
- ClamAV scanning is self-hosted; ADR-018 says "no new sub-processor".
- GeoIP uses a local DB-IP file with no external call (ADR-014, Proposed).
- GitHub, Jira and Outlook calendar integrations (`packages/integrations/src/`) send data where the customer tells us
  to. Whether they are customer-directed recipients or sub-processors is a question for counsel.
- Vendors' own sub-processors (for example AssemblyAI's 18, including Anthropic for LLM processing) must be disclosed
  in the chain (#489 §2.3).

## 9. India DPA template: outline, not legal advice

> **Outline, not legal advice.** Headings and what each clause must cover, mapped to the Act and Rules. Counsel drafts the
> wording. Bracketed choices are **OPTIONS** for Akash.

1. **Parties, roles and scope.** Customer is Data Fiduciary and MeetOps is Data Processor for P1/P5/P6; MeetOps is
   Fiduciary only for its own purposes (P2–P4), outside the DPA. Maps to s. 2(i), 2(k), 8(1), 8(2).
2. **Description of processing (annex).** Categories of Data Principals (members, invited guests, participants who never
   signed up, possibly children); data categories (audio, transcripts, speaker labels, summaries, action items,
   embeddings); purposes; duration. Supports Rule 3 notice by the customer.
3. **Instructions and purpose limitation.** Process only on documented instructions; no training, benchmarking or
   product analytics on content; AI vendors configured with training opt-out and short retention. s. 4, 8(2).
4. **Customer duties.** Notice (s. 5, Rule 3), ground for processing (s. 4, 6, 7), consent withdrawal (s. 6(4)–(6)),
   recording notice and attestation (ADR-020), children and guardians (s. 9, Rules 10–11), Consent Manager use from 13 Nov
   2026 (s. 6(7)–(9), Rule 4).
5. **Security safeguards.** Each Rule 6(1) item: (a) encryption, masking or tokens; (b) access control; (c) logs and
   monitoring; (d) backups and continuity; (e) one-year log retention; (f) this contract itself; (g) organisational
   measures. s. 8(5). Annex of technical measures.
6. **Personal data breach.** Notice timeline [OPTION A/B/C in §4], content mapped to Rule 7(2)(b)(i)–(vi), cooperation,
   log preservation, no direct notice without instruction, CERT-In coordination. s. 8(6), Rule 7.
7. **Sub-processors.** List as annex (§8); general or specific authorisation [OPTION]; prior notice of changes [OPTION:
   number of days]; right to object; same duties flowed down; MeetOps remains answerable to the customer. s. 8(2).
8. **Location and transfers.** Processing location per sub-processor; compliance with any s. 16 notification and Rule 15
   order; handling of foreign-government access requests; India-only option for SDF customers (Rule 13(4)).
9. **Retention, erasure and return.** Follow the customer's retention setting (ADR-019, 7–365 days); erase on instruction,
   on consent withdrawal and at end of service, including provider copies (s. 6(6), 8(7)(b)); keep processing logs at least
   one year (Rule 8(3)); deletion confirmation. Note: the provider-side delete in ADR-019 is not yet implemented (#489 §7).
10. **Data Principal rights.** Help the customer answer access, correction, erasure, grievance and nomination requests
    (ss. 11–14) within its published grievance period, at most 90 days (Rule 14(3)); contact details (s. 8(9), Rule 9).
11. **Accuracy.** Where outputs (for example action items with owners) may be used for decisions about a person, support
    completeness and accuracy (s. 8(3)); human review of AI drafts.
12. **Audit and information.** Evidence of compliance (s. 8(4)); reports and certifications; extra support for SDF
    customers: DPIA, audit, algorithmic due diligence (s. 10(2), Rule 13).
13. **Children and persons with disability.** Customer flags; MeetOps features off where needed; no tracking, behavioural
    monitoring or targeted ads aimed at children (s. 9(3)); Fourth Schedule exemptions only where they apply.
14. **Liability and indemnity.** Allocation in light of s. 8(1) (Fiduciary stays responsible) and the Schedule penalty
    ceilings; caps [OPTION]. No wording here.
15. **Term, termination and exit.** Export, deletion, survival of confidentiality and log duties.
16. **Precedence and other laws.** Order of documents; GDPR or other regimes handled in separate annexes.

## 10. Open questions for counsel

Appended to [legal-questions-brief.md](legal-questions-brief.md) §5 as items 14–21.

## 11. Not verified

- India Code copy of the Act: the request timed out; we used the Gazette copy on MeitY's site [D1].
- The 16 Dec 2025 corrigendum to the Rules was not read (MeitY page access denied earlier; see verification-round-2 §5).
- No s. 16 notification, Rule 15 order, SDF notification or s. 17(3) start-up exemption: "none found" from secondary
  trackers only [D6, D7].
- Breach-notice terms in the AI vendors' DPAs; Resend's and Razorpay's roles and locations.
- Whether CERT-In has amended the 2022 Directions since; we read the original.

## Sources

All fetched 2026-11-12 (IST).

| ID  | Source                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Digital Personal Data Protection Act, 2023 (No. 22 of 2023), Gazette text on MeitY: https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf |
| D2  | G.S.R. 843(E), 13 Nov 2025 (commencement of the Act), e-Gazette: https://egazette.gov.in/WriteReadData/2025/267647.pdf                                                   |
| D3  | G.S.R. 846(E), DPDP Rules, 2025, 13 Nov 2025, Gazette text on MeitY: https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf                |
| D4  | S.O. 5458(E), DPDP (Removal of Difficulties) Order, 2026, e-Gazette: https://egazette.gov.in/WriteReadData/2026/276885.pdf                                               |
| D5  | CERT-In Directions No. 20(3)/2022-CERT-In, 28 Apr 2022: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf                                             |
| D6  | **Secondary.** dpdpr.in, "Cross-border transfers of personal data": https://dpdpr.in/guides/cross-border-transfers/                                                      |
| D7  | **Secondary.** TryTrustable, "DPDP regulatory tracker": https://trytrustable.com/dpdp-regulatory-tracker                                                                 |
