# Legal questions brief: BIPA, EU AI Act Art. 50, ADR-020 notice review

> **Not legal advice.** This is product research written for Akash and for outside counsel. It summarises statute text,
> court filings and official EU pages as we read them on **2026-11-11 (IST)**, and it lists questions for counsel. It
> doesn't say what the law requires of MeetOps. Court rulings cited here are at the pleading stage: a court accepted the
> complaint's allegations as true for the motion; nothing has been proven.

## 1. Why this matters now

- Three AI meeting-capture vendors face class actions over voice data or consent: Otter (wiretap and BIPA claims
  survived a motion to dismiss on 13 Aug 2026) [L1], Fireflies (BIPA; motion to dismiss pending) [L2, L3] and Granola
  (bot-free capture without notice to others) [L4]. A fourth, against Microsoft, says Teams **diarization** creates
  voiceprints [L5, L6].
- MeetOps captures without a bot (extension tab capture, desktop, mobile), labels speakers through AssemblyAI diarization,
  and plans to sell in India, the US and the EU (ADR-017, ADR-019, ADR-020). Each of those touches the questions below.

## 2. Illinois BIPA (740 ILCS 14)

### 2.1 What the statute says (primary text [L7])

- **Definitions (§10).** "Biometric identifier" means "a retina or iris scan, fingerprint, **voiceprint**, or scan of hand
  or face geometry". "Biometric information" is information "based on an individual's biometric identifier used to identify
  an individual". The Act **does not define "voiceprint"**.
- **§15(a):** anyone "in possession of" biometric identifiers must publish a written retention and destruction policy
  (destroy when the purpose is met or within 3 years of the last interaction, whichever is first).
- **§15(b):** before collecting, a private entity must inform the person **in writing**, state the purpose and term, and get
  a **written release**. Since P.A. 103-769 (eff. 2 Aug 2024) a "written release" includes an **electronic signature**.
- **§15(c)–(e):** no selling or profiting; no disclosure without consent (with narrow exceptions); reasonable-care storage.
- **§20 damages:** $1,000 per negligent violation or $5,000 per intentional/reckless violation (or actual damages if
  greater), plus fees. Since P.A. 103-769, repeated collection of the same identifier from the same person by the same
  method is **one** violation of §15(b) (and similarly for §15(d)).

### 2.2 Does speaker labelling or diarization count as a voiceprint?

No court has decided this on the merits in the filings we read. What the filings show:

| Case                                                                     | Theory                                                                                                                                                                                                   | Status (as read)                                                                                                                                                                                           | Source    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| _In re Otter.ai Privacy Litigation_, 5:25-cv-06911-EKL (N.D. Cal.)       | Otter "stores each voiceprint so that, in future meetings, Otter can identify the same individuals"; speaker tagging creates a "speaker identification profile"                                          | 13 Aug 2026: BIPA §15(a) and §15(b) claims **survive** a motion to dismiss. The court held voiceprints are biometric identifiers and the allegations plausibly show they "can be and are used to identify" | [L1, L12] |
| _Fricker v. Fireflies.AI Corp._, 1:26-cv-02675 (N.D. Ill.), consolidated | "Speaker Recognition" records, analyses and stores voiceprints of all participants, including non-users; §15(a), (b), (d)                                                                                | Motion to dismiss filed 15 Jul 2026 (standing, personal jurisdiction, extraterritoriality); no ruling as of 19 Oct 2026 per a secondary docket summary                                                     | [L2, L3]  |
| _Basich v. Microsoft Corp._, 2:26-cv-00422 (W.D. Wash.)                  | Teams live-transcription **diarization** ("Speaker A" vs "Speaker B") extracts pitch, tone and timbre, which is said to be a voiceprint. The proposed class excludes people who enrolled a voice profile | Amended complaint 22 Jun 2026; motions to compel arbitration and to dismiss filed; no ruling in the docket entries we read (to 5 Nov 2026)                                                                 | [L5, L6]  |

**Reading for product (not a legal conclusion).** The Otter ruling turned on _persistent_ profiles that recognise a person
across meetings. Basich tests the broader theory that _per-meeting_ diarization alone is enough. If Basich survives, the
safe assumption narrows sharply.

### 2.3 What MeetOps does today (from the repo)

- STT is AssemblyAI with `speaker_labels` on by default (`packages/ai-core/src/adapters/assemblyai.ts`,
  `apps/worker/src/ai/providers/assemblyai.ts`). Labels come back per request.
- We map chunk-local labels to recording-wide `S1, S2…` **by time overlap**, not by voice features
  (`packages/ai-core/src/transcription/merge.ts`, `docs/09-ai/transcription.md`).
- Names attach through `meeting_participants.speaker_label` (`packages/database/prisma/schema.prisma`,
  `MeetingParticipant`). We found **no stored voice embedding or cross-meeting voice profile** in the schema or the
  transcription code we read.
- ADR-019 deletes AI provider copies "right after processing".

### 2.4 Questions for counsel (BIPA)

1. Is per-meeting diarization done by a processor (AssemblyAI) a "collection" or "capture" of a voiceprint by MeetOps, by
   the customer org, or by both? Who is the "private entity" under §15(b)?
2. If we never persist voice features and never match a voice across meetings, does that take us outside the Otter theory?
   What would we need to show (architecture, vendor terms, deletion logs)?
3. Should we offer an Illinois mode (or a global mode) that turns diarization off, or labels speakers from the platform's
   participant data only? Proposal #11 in PR #468 sketches a "biometric-free speaker mode".
4. If any biometric processing remains, is a §15(b) written release from **every** participant feasible in a meeting (the
   consent receipt in [specs/03](specs/03-consent-receipts.md) could carry an e-signature)? Is a §15(a) public retention
   policy needed anyway as a precaution?
5. What do AssemblyAI's DPA and terms say about voice data and retention? (We haven't read them for this brief.)
6. Does the customer contract need a BIPA allocation clause (who obtains releases, indemnity)?

## 3. EU AI Act, Article 50

### 3.1 Text and timeline (primary)

- Regulation (EU) 2024/1689, **Art. 50** [L8]:
  - **50(1)** Providers of AI systems "intended to interact directly with natural persons" must design them so people are
    informed they are interacting with AI, unless obvious.
  - **50(2)** Providers of AI systems "generating synthetic audio, image, video or text content" must mark outputs "in a
    machine-readable format and detectable as artificially generated or manipulated". It does **not** apply "to the extent
    the AI systems perform an assistive function for standard editing or do not substantially alter the input data".
  - **50(3)** Deployers of an **emotion recognition** or **biometric categorisation** system must inform the people exposed.
  - **50(4)** Deployers must disclose deepfakes, and AI-generated text "published with the purpose of informing the public
    on matters of public interest" (unless human-reviewed with editorial responsibility).
  - **50(5)** Information must be given "at the latest at the time of the first interaction or exposure".
- **Dates.** Art. 113: the Regulation applies from **2 Aug 2026** [L8]. The Commission's page: "Article 50 of the AI Act
  applies from 2 August 2026" [L10]. The **Digital Omnibus on AI, Regulation (EU) 2026/1744**, adds Art. 111(4): providers
  of generative systems placed on the market **before** 2 Aug 2026 must comply with Art. 50(2) by **2 Dec 2026** [L9]. The
  Omnibus moved high-risk obligations to 2 Dec 2027 (Annex III) and 2 Aug 2028 (Annex I) [L9]; a Dutch law firm summary
  agrees and puts Art. 50 fines at up to €15M or 3% of turnover [L11].
- The Commission has published **guidelines on Art. 50** and a Code of Practice on marking AI-generated content [L10].
  We have not read the full guidelines PDF for this brief.

### 3.2 How Art. 50 might touch MeetOps (questions, not conclusions)

| Feature                                                                            | Possible hook                                        | Open point                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI summaries, action items, follow-up drafts (`packages/ai-core/src/extraction/*`) | 50(2) machine-readable marking of generated text     | Is a meeting summary "synthetic text", or does the "does not substantially alter the input" carve-out apply? Do the guidelines give examples?                                                                                     |
| Transcripts                                                                        | 50(2)                                                | Likely closer to the carve-out (transcription of input), but confirm                                                                                                                                                              |
| Chat over meetings ("Ask", semantic search in P7)                                  | 50(1) interaction with AI                            | Probably "obvious" in-product, but confirm labelling                                                                                                                                                                              |
| Speaker diarization; any future sentiment or "tone" analysis                       | 50(3) emotion recognition / biometric categorisation | Art. 3(40) excludes categorisation "ancillary to another commercial service and strictly necessary for objective technical reasons". Is diarization that? We don't do emotion recognition today; keep it that way unless reviewed |
| Summaries a customer publishes externally                                          | 50(4) (deployer)                                     | Customer's duty, but do we need a product affordance (label on export)?                                                                                                                                                           |

- **Provider vs deployer.** MeetOps would likely be the **provider** of the system (Art. 3(3)) and the customer org the
  **deployer** (Art. 3(4)). Counsel should confirm, including for the LLM we call (Gemini per ADR-019).
- **Timing.** If any MeetOps generative feature counts as "placed on the market" before 2 Aug 2026, the Art. 50(2)
  deadline may be **2 Dec 2026**, three weeks from today. We don't know whether MeetOps has EU customers yet.

### 3.3 Questions for counsel (AI Act)

1. Do summaries and action items fall under Art. 50(2), or under the "assistive / does not substantially alter" carve-out?
2. If 50(2) applies, what marking is acceptable for text (metadata in exports and API responses, a visible label, both)?
3. Are we in scope at all before we have EU customers? What counts as "placing on the market" for a SaaS reachable from the
   EU?
4. Is diarization a "biometric categorisation system" under Art. 3(40), or excluded as ancillary and strictly necessary?
5. How do Art. 50 notices interact with ADR-020's consent notice? Can one notice satisfy both (Art. 50(5) timing)?

## 4. ADR-020 consent-notice review

ADR-020 (accepted 2026-11-01) sets all-party consent everywhere, a notice-based default, explicit consent by default for
EU/UK orgs (the project lead decided on 2026-11-11 to make explicit consent the default for all orgs until the system
stores an org country; `docs/research/competitive-landscape.md` §4 records this, and it is not yet in an ADR), capture stops on `consent_revoked`, `CURRENT_CONSENT_VERSION`, and **item 7: one fixed-fee legal review
(India, US, EU) of the notice text and DPA before GA** (`docs/15-decisions/ADR-020-recording-consent.md`).

### 4.1 Points we found for that review

1. **The default notice assumes a bot we don't ship.** ADR-020 item 2 and `docs/12-security/upload-media-security.md` §7
   describe a "visible recorder name ('MeetOps Recorder'), a chat notice on join". The apps in the repo are api, web,
   worker, realtime, extension, desktop and mobile; there is no bot app, though `MeetingSource` includes `bot`
   (`packages/database/prisma/schema.prisma`). The extension's notice is shown **to the recording user** in the popup
   (`docs/05-web/extension.md`, "Consent flow"), and Chrome's tab-capture indicator is on the recorder's own screen.
   _Question:_ with botless capture, how do other participants receive notice? The Granola complaint is built on exactly
   this gap ("[o]ther people in the room won't know") [L4].
2. **The ledger records the host, not each participant.** `meeting_consent_events.actor_user_id` is a signed-in user
   (`packages/contracts/src/api/meeting-consent.ts`); external participants have no record. _Question:_ is "host attests
   that all parties were notified" enough evidence in all-party states and under GDPR Art. 13? Spec
   [03-consent-receipts](specs/03-consent-receipts.md) proposes per-participant receipts.
3. **Illinois is in ADR-020's all-party list** (eavesdropping). BIPA (§2 above) is a separate statute with a stricter
   _written_ release; the notice-based default doesn't produce one. _Question:_ does diarization need a BIPA path?
4. **Revocation.** "Capture stops on `consent_revoked`", but today only org members can post a revocation (route
   `/orgs/:organizationId/meetings/:meetingId/consent/revoke`, roles owner/admin/member). _Question:_ must a non-member
   participant be able to object/revoke, and what must happen to media already captured (ADR-019 retention)?
5. **GDPR erasure vs append-only consent evidence.** ADR-020 notes `ON DELETE RESTRICT` blocks deleting attesting users;
   it suggests pseudonymising and keeping evidence under Art. 17(3)(e). _Question:_ is that acceptable, and for how long?
6. **AI Act notice.** Should the consent notice also carry the Art. 50 information (§3.3 Q5)?
7. **India DPDP.** ADR-019 says DPDP erasure and notice duties apply from 13 May 2027. _Question:_ do the notice text and
   consent records meet DPDP notice requirements for participants who aren't customers?

### 4.2 What to send counsel

- ADR-020, ADR-019, `docs/12-security/upload-media-security.md` §7, the extension consent copy (`CONSENT_NOTICE` in
  `apps/extension/src/lib/consent.ts`), the mobile `ConsentSheet` (`apps/mobile/src/consent/ConsentSheet.tsx`), the web
  consent settings (`apps/web/src/features/settings/consent-settings-panel.tsx`), the DPA draft (if any), and this brief.
- Ask for a fixed-fee scope covering §2.4, §3.3 and §4.1.

## 5. Consolidated open questions (for the counsel call)

1. Does per-meeting diarization by our STT vendor make MeetOps (or the customer) a collector of voiceprints under BIPA?
2. Should we ship a diarization-off / participant-data-only speaker mode for Illinois, or globally?
3. Is a host attestation enough notice for botless capture, or do we need per-participant notice and receipts?
4. Must non-member participants be able to revoke, and what happens to captured media then?
5. Are AI summaries "synthetic text" under Art. 50(2)? If so, what marking, and is 2 Dec 2026 our deadline?
6. Is diarization "biometric categorisation" under the AI Act?
7. Can one notice satisfy ADR-020, GDPR Art. 13, DPDP and AI Act Art. 50?
8. How should the customer contract allocate consent and BIPA duties?
9. AssemblyAI's Biometric Data Addendum makes the customer give notice and get written consent "on behalf of" AssemblyAI
   and indemnify it, and its FAQ says diarization is an opt-in feature whose speaker embeddings "may be deemed biometric
   data" but are not kept after the transcript is returned. Our worker turns diarization on by default. Does that make
   every diarized chunk a "Biometric Feature" use, and what notice and consent wording would cover it? (See
   [ai-provider-due-diligence.md](ai-provider-due-diligence.md) §2.3.)
10. AssemblyAI's Terms §4.3(b) license Customer Data for model training (opt-out on paid plans only) and §4.6 let it own
    and use De-Identified Data for any purpose. Does this fit MeetOps' processor role under our customer DPA and DPDP,
    and must it be disclosed to customers or switched off contractually?
11. The paid Gemini API logs prompts and responses for abuse detection and may store or cache them "in any country". Is
    that acceptable for Indian customers' meeting content under DPDP cross-border rules, or should customer data use a
    regional processor (for example Vertex AI in Mumbai)?
12. ADR-019 promises AI provider copies are deleted right after processing, but no provider delete call exists yet and
    AssemblyAI keeps transcripts 30 days by default. What must the DPA and sub-processor list say until that is fixed?
13. Sarvam's Terms allow training on inputs "(where required) subject to your consent", and its privacy policy names
    itself a Data Fiduciary. In a MeetOps → Sarvam API flow, who must give or collect that consent, and is Sarvam a
    processor for us?
14. DPDP roles (see [dpdp-role-and-dpa-outline.md](dpdp-role-and-dpa-outline.md) §3): is MeetOps a Data Processor for
    customer meeting content, including speech by participants who never signed up, and a Data Fiduciary only for its
    own account, billing, analytics and marketing data? What would make it a joint Fiduciary "in conjunction with" the
    customer (s. 2(i)), for example letting an AI vendor train on content?
15. For non-member participants, what ground under s. 4 does the customer have: consent (s. 6), or "voluntarily
    provided" (s. 7(a)) by speaking after the recording notice? Does the ADR-020 notice-based default meet s. 5 and Rule 3?
16. Commencement: G.S.R. 843(E) is in Gazette issue No. 757 dated 13 Nov 2025, and only the Rules (G.S.R. 846(E)) are in
    Gazette issue No. 760 dated 13 Nov 2025; the e-Gazette IDs and signatures on both read 14 Nov 2025. Is the 18-month
    date 13 May 2027 or 14 May 2027, and is the Consent Manager date 13 or 14 Nov 2026?
17. Breach: what processor-to-customer notice period should the India DPA set so customers can meet Rule 7(2)(b)'s 72
    hours, and how should it sit with CERT-In's 6-hour reporting, which we read as applying to MeetOps directly?
18. Children: when a customer's meeting includes under-18 participants, what must MeetOps provide as processor so the
    customer can meet s. 9(1) and Rule 10? Is diarization or speaker analytics "tracking or behavioural monitoring" under
    s. 9(3)?
19. Does s. 17(1)(d) exempt MeetOps' processing in India of meeting content of people outside India for foreign customers,
    and which duties (s. 8(1), 8(5)) remain?
20. Are customer-directed integrations (GitHub, Jira, Outlook calendar) sub-processors, or recipients chosen by the
    customer as Fiduciary? Is Razorpay our processor or its own Fiduciary for payment data?
21. Rule 8(3) makes the Fiduciary keep processing logs, including its Processor's, for at least a year. How does that sit
    with ADR-019's "AI provider copies deleted right after processing" and with customer retention settings as short as 7
    days?
22. CERT-In direction (iv) of 28 Apr 2022 says logs are kept for 180 days "within the Indian jurisdiction", but CERT-In's
    own FAQ Q35 says they "may be stored outside India" if they can be produced in reasonable time, and calls itself
    "not a legal document". Can MeetOps keep its logs, or its sub-processors' logs, outside India? (See
    [verification-round-3.md](verification-round-3.md) §3.)
23. AssemblyAI, Google and Resend promise breach notice only "without undue delay", with no hour limit, and none of their
    DPAs names the DPDP Act. CERT-In needs a report within 6 hours, and DPDP Rule 7(2)(b) gives the Data Fiduciary 72
    hours for details to the Board. Must our sub-processor terms set fixed hours, and when a breach happens at a foreign
    sub-processor, whose 6-hour CERT-In clock applies? (See [verification-round-3.md](verification-round-3.md) §4.)
24. Razorpay publishes no DPA. Its terms make us "solely and absolutely responsible" for our customers' data, and its
    privacy policy gives DPDP rights directly. Is Razorpay an independent Data Fiduciary for payment data it must hold in
    India under RBI rules, and what should our privacy notice and sub-processor list say about it? (See
    [verification-round-3.md](verification-round-3.md) §4.)
25. Razorpay's Terms Part A §12.3 require us to tell Razorpay within 24 hours of any actual or suspected breach of
    customer data in our systems. Does that apply to MeetOps as a SaaS merchant, and how should it sit in our incident
    runbook next to the CERT-In 6-hour and DPDP 72-hour duties?
26. Eval-data consent wording. Does the consent form in
    [design-partner-kit/hinglish-eval-data-protocol.md](design-partner-kit/hinglish-eval-data-protocol.md) §3 (English
    §3.1, Hindi §3.2) meet s. 5, s. 6(1)–(3) and Rule 3 of the DPDP Rules? Is our Hindi draft an adequate Eighth
    Schedule version under s. 5(3) and s. 6(3), and should counsel or a certified translator sign it off? The Hindi text
    is our own draft translation and is marked there as needing native-speaker review.
27. Withdrawal and de-identified eval data. Under s. 6(4) a speaker may withdraw "at any time"; s. 6(5) says withdrawal
    "shall not affect the legality of processing ... before its withdrawal"; s. 6(6) requires processing to cease
    "within a reasonable time", and s. 8(7)(a) requires erasure "upon the Data Principal withdrawing her consent" unless
    a law requires retention [L13]. The Act defines personal data as data about an individual "who is
    identifiable by or in relation to such data" (s. 2(t)) [L13] and has no separate rule for anonymised or de-identified data.
    May verified, de-identified reference transcripts (protocol §4.2) be kept after the speaker withdraws if they no
    longer identify that speaker, or must they be deleted as the protocol now proposes (§5, "On withdrawal")? Does a
    transcript of a real meeting stay "personal data" because colleagues could still recognise who spoke, and what
    "reasonable time" for deletion would counsel accept (the protocol proposes 30 days)?
28. Consent-record retention. Section 6(10) puts on the Data Fiduciary the burden to prove that notice was given and
    consent obtained. How long should we keep signed eval consent forms, the consent register and withdrawal records
    after the related data is deleted (protocol §5 leaves "[period for counsel]")? The Rules set no period for a
    Fiduciary's own consent records. Rule 8(3) is narrower than a general log rule: it requires a Data Fiduciary to retain
    "such personal data, associated traffic data and other logs of the processing" for at least one year "for the
    purposes as specified in the Seventh Schedule", and then to erase them unless another law requires longer [L14]. The
    Seventh Schedule lists three purposes: (1) use by the State or any of its instrumentalities "in the interest of
    sovereignty and integrity of India or security of the State"; (2) use by the State or its instrumentalities for
    "performance of any function under any law for the time being in force in India" or "disclosure of any information
    for fulfilling any obligation under any law for the time being in force in India"; and (3) "assessment for notifying
    any Data Fiduciary or class of Data Fiduciaries as Significant Data Fiduciary" [L14]. Rule 23 is not a purpose: it
    is the Central Government's power to call for information from a Data Fiduciary or intermediary for those Seventh
    Schedule purposes, through the authorised person the Schedule names. Rule 8(3) is not a consent-record rule.
    Consent Managers must keep consent records for at least seven years (First Schedule, Part B, item 4(c)) [L14]. Is
    either a sensible benchmark, and how does a longer period sit with s. 8(7) erasure and data minimisation?
29. Rule 8(3) and account deletion. Rule 8(3) requires keeping "such personal data, associated traffic data and other
    logs of the processing" for at least a year, and its illustration says the platform keeps them "even if X deletes
    her account". For a meeting app, does that cover meeting content (recordings, transcripts) or only records of the
    processing? ADR-019 assumes the latter. Details and sources:
    [account-deletion-erasure-brief.md](account-deletion-erasure-brief.md) §2 (E2).
30. Consent evidence after account or org deletion. How long may we keep pseudonymised consent attestations and
    meeting consent events after the attesting user, or the whole org, is deleted? Is s. 6(10) a basis when the
    attestation is the host's statement about other participants, and what limitation period should set the end date,
    in India and for GDPR Art. 17(3)(e)? See [account-deletion-erasure-brief.md](account-deletion-erasure-brief.md) §2.2.
31. Grace period and GDPR timing. For EU users, is a 30-day grace the user chose, followed by deletion and 35-day backup
    roll-off, compatible with Art. 12(3)'s "within one month"? Or must the grace be shorter or optional? See
    [account-deletion-erasure-brief.md](account-deletion-erasure-brief.md) §4.3.
32. Whose meetings are they? When a member deletes their account, are meetings they recorded in someone else's org the
    org's data (kept) or theirs (deleted, or their voice and name removed from transcripts)? Does it change if MeetOps
    is a Processor for that org ([dpdp-role-and-dpa-outline.md](dpdp-role-and-dpa-outline.md))?
33. Is pseudonymisation erasure? Is a `users` row scrubbed down to its uuid "erased" under s. 12(3), given it still
    links consent and audit rows? GDPR Recital 26 treats pseudonymised data as personal data. See
    [account-deletion-erasure-brief.md](account-deletion-erasure-brief.md) §2.2.

## Sources (fetched 2026-11-11; L13–L14 read 2026-11-18)

| ID  | Source                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Order granting motion to dismiss in part, _In re Otter.ai Privacy Litigation_, 5:25-cv-06911-EKL, Dkt. 68 (13 Aug 2026): https://storage.courtlistener.com/recap/gov.uscourts.cand.454675/gov.uscourts.cand.454675.68.0.pdf                    |
| L2  | Consolidated Class Action Complaint, _Fricker v. Fireflies.AI Corp._, 1:26-cv-02675, Dkt. 27 (24 Jun 2026): https://storage.courtlistener.com/recap/gov.uscourts.ilnd.496785/gov.uscourts.ilnd.496785.27.0.pdf                                 |
| L3  | Docket summary by Scribbl (a competitor), updated 19 Oct 2026; **secondary**: https://scribbl.co/post/fireflies-ai-lawsuit                                                                                                                     |
| L4  | Class Action Complaint, _Chamberlain v. Granola, Inc._, 3:26-cv-07926 (30 Jul 2026): https://storage.courtlistener.com/recap/gov.uscourts.cand.475308/gov.uscourts.cand.475308.1.0.pdf                                                         |
| L5  | Docket, _Basich v. Microsoft Corp._, 2:26-cv-00422 (W.D. Wash.): https://www.courtlistener.com/docket/72237819/basich-v-microsoft-corporation/                                                                                                 |
| L6  | Darrow, "Evaluating Litigation Risk: Basich v. Microsoft" (16 Feb 2026); **secondary**, describes the diarization theory: https://www.darrow.ai/resources/evaluating-litigation-risk-basich-v-microsoft                                        |
| L7  | 740 ILCS 14 (BIPA), Illinois General Assembly: https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=3004&ChapterID=57                                                                                                                         |
| L8  | Regulation (EU) 2024/1689 (AI Act), EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689                                                                                                                           |
| L9  | Regulation (EU) 2026/1744 (Digital Omnibus on AI), EUR-Lex: https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng                                                                                                                                 |
| L10 | European Commission, Guidelines on transparency obligations (Art. 50): https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-transparency-obligations                                                                                |
| L11 | Houthoff, "AI Act: transparency obligations and the AI Omnibus Regulation" (1 Sep 2026); law-firm summary: https://www.houthoff.com/insights/news/ai-act-transparency-obligations-and-the-ai-omnibus-regulation/                               |
| L12 | Taft, "AI-Powered Call Transcription Tools Present Class Action BIPA Risk" (8 Sep 2026); legal press on L1: https://www.privacyanddatasecurityinsight.com/2026/09/ai-powered-call-transcription-tools-present-class-action-bipa-risk/          |
| L13 | Digital Personal Data Protection Act, 2023 (No. 22 of 2023), ss. 2(t), 5, 6(1)–(6), 6(10), 8(7), Gazette text on MeitY: https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf                                   |
| L14 | DPDP Rules, 2025 (G.S.R. 846(E), Gazette No. 760), Rule 3, Rule 8(3) with the Seventh Schedule, Rule 23, and First Schedule Part B item 4(c), MeitY copy: https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf |
