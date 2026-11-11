# Market gaps, pain points, size and trends (November 2026)

- Checked: 2026-11-11 (IST). Evidence comes from pages fetched that day. Source IDs (S…) match
  [competitive-landscape.md](competitive-landscape.md#sources-all-fetched-2026-11-11). New sources here use M….
- **Estimate** marks any figure that is a third-party projection or our own reasoning, not a measured fact.
- "Not found" means none of the ~19 vendor pages we fetched showed it. That supports "rare", not "nobody does it".

## 1. Unmet needs and pain points

Each gap lists the evidence, who partly covers it today, and why the gap is still open.

### G1. Consent for people who never signed up

- **Evidence.** A consolidated class action accuses Otter's notetaker of recording meetings without consent from all
  participants. The court let wiretap (ECPA, CIPA), Illinois BIPA, unjust-enrichment and UCL claims go forward [S30, S31].
  The NPR report says Otter asks the host by default, "but it does not by default ask all the other participants" [S30].
- **Partial cover.** MeetGeek has "recording consent notifications" with approval tracking [S13]. Sembly lists "notification
  and consent tracking" on higher tiers [S23]. Google lets admins require explicit consent from every participant, but that
  setting is off by default [S16]. Granola Enterprise adds an org-wide notice that Granola is in use [S7].
- **Why it's open.** Most of this cover is optional, sold on higher tiers, or off by default. None of the fetched pages
  offer a participant-facing record of what notice each person saw, or a way for one participant to revoke.

### G2. Bots that spread on their own, and weak admin control

- **Evidence.** An MSP describes notetakers that "spread like viruses to other meeting attendees". After one meeting with a
  bot, users found Otter and Read.ai joining their own meetings [M1]. A sysadmin says Fireflies "is adding itself to every
  meeting that user is in" after one click, and the post-meeting emails kept coming even after the Teams app was blocked [M2].
- **Partial cover.** MeetGeek offers "One Bot Per Meeting" and rules to skip meetings [S13]. Granola never auto-joins
  [S7b]. Many vendors have moved to botless capture (see [competitive-landscape.md](competitive-landscape.md) §1).
- **Why it's open.** Sign-up growth still runs on emailing non-users and joining from calendars. We found no vendor that sells
  "no viral spread, admin-approved rollout only" as a guarantee.

### G3. Voiceprints and biometric exposure

- **Evidence.** Two class actions under Illinois BIPA (Cruz, filed 18 Dec 2025; the consolidated Fricker and Martinez
  complaint, filed 24 Jun 2026) say Fireflies' "speaker recognition" creates voiceprints of non-users without written
  consent or a published retention policy [S32, S33]. SGR notes that BIPA statutory damages are $1,000–$5,000 per violation
  [S32].
- **Why it's open.** Naming speakers is a selling point in nearly every product (Otter, Jamie "speaker recognition &
  memory", Sembly "every speaker identified by name") [S1, S15, S23b]. None of the fetched pages offer a mode that keeps
  no biometric data.

### G4. Action items and decisions that can't be trusted

- **Evidence.** Users report discussions written up as decisions and action items given to the wrong person. One reply
  says "provenance is the thing almost none of them give you by default" [S35]. Notion AI meeting notes swap host and
  guest and repeat the mistake after correction. The user asks for "unclear attribution" flags instead of guesses [S36].
  On G2, Otter's top complaints are missed words, inconsistent speaker identification and accent accuracy [S34].
- **Partial cover.** Transcripts with timestamps and "Ask" chat are common. Fireflies lets users pick which tasks to send
  [S22].
- **Why it's open.** None of the fetched pages mention labelling how firm a commitment was (proposed, discussed or decided),
  evidence on every item, or an explicit "unclear owner" state.

### G5. The summary-to-execution gap

- **Evidence.** A user says summaries cover "what was discussed" but are weak at "what actually needs to happen next":
  tasks aren't created, owners are unclear, and someone has to translate the summary into work by hand [M3].
- **Partial cover.** Tools now push tasks: Fireflies to Linear (issues created automatically, with team, project and status
  chosen) [S21]; tl;dv to Jira, Asana, ClickUp, Monday and Trello [S4b]; Fellow to and from GitHub through Zapier [S25];
  note1 links to existing GitHub issues before creating new ones [S26].
- **Why it's open.** These are one-way pushes or connectors built on Zapier. None of the fetched pages describe a closed
  loop where the next meeting shows the live Jira/GitHub status of tasks from the last one, or per-team follow-through rates.

### G6. Mixed-language meetings (e.g. Hindi and English)

- **Evidence.** A user whose meetings mix Hindi and English says Fireflies, Meetily and others "arent able to capture the
  Hindi + English Voices properly" [S37]. Otter transcribes six languages, and Hindi is not one of them [S1]. Gemini in Meet
  "supports one language at a time" [S16].
- **Partial cover.** Fireflies has a "Multi-language Mode" (Business) [S2]. MeetGeek auto-detects language [S13]. Our default
  provider documents code switching: AssemblyAI says Universal-3.5 Pro "natively handles code switching across 18
  languages", Hindi included [M4].
- **Why it's open.** Real-world complaints remain, and the big suites handle one language per meeting.

### G7. Compliance locked in top tiers

- **Evidence.** HIPAA, SSO/SCIM, custom retention and residency sit in Enterprise or the top paid tiers at Otter, Fireflies,
  Read, Granola, Avoma, Krisp and Bluedot [S1, S2, S6, S7, S8, S12, S14]. Fathom is the exception: HIPAA with a standard BAA
  on its Team plan [S3].
- **Why it's open.** Small regulated teams (clinics, law firms, agencies with client NDAs) pay enterprise prices or go
  without.

### G8. Data residency outside the US and EU

- **Evidence.** Read offers EU and Canada hosting on Enterprise+ [S6]. MeetGeek offers EU or US storage [S13]. Krisp lets
  Enterprise customers choose a data centre [S12]. Granola stores notes in a US-hosted AWS VPC [S7b]. None of the fetched
  pages mention India hosting.
- **Context.** India's DPDP Rules 2025 were notified on 13 Nov 2025. Erasure and notice duties apply from 13 May 2027
  (G.S.R. 843(E) and Rule 1 of the DPDP Rules 2025, read on 2026-11-12; see [verification-round-2.md](verification-round-2.md) §5, R2-D1, R2-D2. The dates match ADR-019).
- **Why it's open.** Not found for India. This matters to the owner's home market and to ADR-017's INR billing.

### G9. Meetings across organisations and platforms

- **Evidence.** Copilot "won't work in meetings that are hosted outside the participant's organization" [S17]. Gemini
  "Take notes for me" runs inside Google Meet [S16]. ZoomMate's My Notes does cover third-party and in-person meetings,
  but Basic allows only 3 uses a month [S10].
- **Why it's open.** Agencies and client-delivery teams (README target users) spend much of their time in other companies'
  meetings.

### G10. Privacy defaults that surprise users

- **Evidence.** The Verge found that Granola notes were viewable by anyone with the link by default and used for internal
  training unless the user opted out [S38]. Granola's help centre now offers stricter settings, but org-wide enforcement is
  Enterprise-only [S7c]. A Reddit commenter says sign-up consent screens bury the fact that the tool will auto-join meetings
  [M5].
- **Why it's open.** Private-by-default sharing and training opt-out are often per-user settings, not guarantees.

## 2. Market size (all **estimates**)

| Publisher                 | Scope                                   | Figures                                                                                                                                                                                      | Source |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| The Business Research Co. | "AI-powered meeting assistants", global | **Estimate:** $3.14B (2025) → $3.91B (2026) → $9.33B (2030), 24.3% CAGR 2026–2030 (another passage on the same page says 24.6%). North America largest in 2025; Asia-Pacific fastest-growing | [M6]   |
| Technavio                 | "AI meeting assistants", global         | **Estimate:** grows by $3.46B from 2024 to 2029 at 28.2% CAGR; North America ~40% of growth                                                                                                  | [M7]   |

Caveats:

- The two publishers define the market differently and use proprietary methods. Treat them as a range, not one number.
- The Technavio page also says "Software segment was valued at USD 395.30 billion in 2023". That figure contradicts its own
  headline, so we don't rely on its segment numbers.
- **Our estimate, not sourced:** the reachable market for MeetOps is a small slice of this. It is engineering, product and
  delivery teams that need tasks pushed into Jira or GitHub. We did not find a published figure for that slice.

## 3. Trends

1. **Botless capture is spreading.** Granola, Jamie, Krisp, Bluedot and Meetily are botless [S7, S15, S12, S14b, S19].
   Fireflies, MeetGeek, tl;dv and Fathom (beta) now offer a botless option [S2, S13, S4, S3].
2. **Credits and usage billing.** ZoomMate includes 2,200 AI credits per user per month [S10]. Microsoft bills Copilot
   Cowork, Autopilot and the Work IQ APIs by usage [S11]. Fireflies (AI credits) and Sembly ("Studio credits") meter AI
   features [S2, S23]. Supernormal moved to credit-based plans [S28].
3. **MCP and LLM connectors are standard.** Otter, Fathom, Granola, Read, MeetGeek, Krisp, Bluedot, Avoma, Jamie and Sembly
   all advertise MCP [S1, S3, S7, S6, S13, S12, S14, S8, S15, S23b].
4. **From notes to agents.** Fireflies promotes "Fred, your AI teammate" [S2]. ZoomMate sells custom agents and workflows
   [S10]. Gong positions an "execution layer" for AI agents [S5b]. MeetGeek offers voice agents [S13].
5. **Legal pressure on consent.** Wiretap suits (Otter) and BIPA suits (Fireflies) [S30–S33]. In the EU, AI Act Article 50
   transparency duties start on 2 August 2026, under Article 113. They include telling people when they are dealing with an
   AI system [M8]. Whether Article 50 covers a meeting notetaker is a legal question for counsel. We are not claiming it does.

## 4. What this means for MeetOps

- G1, G2, G3 and G10 (consent and trust) line up with decisions MeetOps already made: ADR-020 all-party consent, botless
  capture, and no covert recording (HANDOFF §3). That is positioning we can ship, not new research.
- G4 and G5 (trust and execution) line up with the core flow: evidence-linked drafts → approval → GitHub/Jira → status sync.
- G6 and G8 (language and residency) are where an India-based team has a real edge.
- Concrete proposals are in [feature-proposals.md](feature-proposals.md).

## Sources added in this doc (fetched 2026-11-11)

| ID  | URL                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | https://www.reddit.com/r/msp/comments/1k75g8g/ai_meeting_notetakers_are_the_bane_of_my_existence/                                                                             |
| M2  | https://www.reddit.com/r/sysadmin/comments/1o0njwy/teams_meeting_ai_note_taker_virus/                                                                                         |
| M3  | https://www.reddit.com/r/ChatGPTPro/comments/1qq8c90/limitations_of_ai_meeting_summaries_when_it_comes/ (page fetch returned the title only; body read from the search index) |
| M4  | https://www.assemblyai.com/docs/pre-recorded-audio/code-switching                                                                                                             |
| M5  | https://www.reddit.com/r/Zoom/comments/1o1watj/beware_of_ai_meeting_notetakers_that_join_ur/ (original post deleted; the cited comment was read from the search index)        |
| M6  | https://www.thebusinessresearchcompany.com/report/artificial-intelligence-ai-powered-meeting-assistants-global-market-report                                                  |
| M7  | https://www.technavio.com/report/ai-meeting-assistants-market-industry-analysis                                                                                               |
| M8  | https://artificialintelligenceact.eu/article/50/                                                                                                                              |
