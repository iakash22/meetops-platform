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

## Sources (fetched 2026-11-11)

| ID  | Source                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Order granting motion to dismiss in part, _In re Otter.ai Privacy Litigation_, 5:25-cv-06911-EKL, Dkt. 68 (13 Aug 2026): https://storage.courtlistener.com/recap/gov.uscourts.cand.454675/gov.uscourts.cand.454675.68.0.pdf           |
| L2  | Consolidated Class Action Complaint, _Fricker v. Fireflies.AI Corp._, 1:26-cv-02675, Dkt. 27 (24 Jun 2026): https://storage.courtlistener.com/recap/gov.uscourts.ilnd.496785/gov.uscourts.ilnd.496785.27.0.pdf                        |
| L3  | Docket summary by Scribbl (a competitor), updated 19 Oct 2026; **secondary**: https://scribbl.co/post/fireflies-ai-lawsuit                                                                                                            |
| L4  | Class Action Complaint, _Chamberlain v. Granola, Inc._, 3:26-cv-07926 (30 Jul 2026): https://storage.courtlistener.com/recap/gov.uscourts.cand.475308/gov.uscourts.cand.475308.1.0.pdf                                                |
| L5  | Docket, _Basich v. Microsoft Corp._, 2:26-cv-00422 (W.D. Wash.): https://www.courtlistener.com/docket/72237819/basich-v-microsoft-corporation/                                                                                        |
| L6  | Darrow, "Evaluating Litigation Risk: Basich v. Microsoft" (16 Feb 2026); **secondary**, describes the diarization theory: https://www.darrow.ai/resources/evaluating-litigation-risk-basich-v-microsoft                               |
| L7  | 740 ILCS 14 (BIPA), Illinois General Assembly: https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=3004&ChapterID=57                                                                                                                |
| L8  | Regulation (EU) 2024/1689 (AI Act), EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689                                                                                                                  |
| L9  | Regulation (EU) 2026/1744 (Digital Omnibus on AI), EUR-Lex: https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng                                                                                                                        |
| L10 | European Commission, Guidelines on transparency obligations (Art. 50): https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-transparency-obligations                                                                       |
| L11 | Houthoff, "AI Act: transparency obligations and the AI Omnibus Regulation" (1 Sep 2026); law-firm summary: https://www.houthoff.com/insights/news/ai-act-transparency-obligations-and-the-ai-omnibus-regulation/                      |
| L12 | Taft, "AI-Powered Call Transcription Tools Present Class Action BIPA Risk" (8 Sep 2026); legal press on L1: https://www.privacyanddatasecurityinsight.com/2026/09/ai-powered-call-transcription-tools-present-class-action-bipa-risk/ |
