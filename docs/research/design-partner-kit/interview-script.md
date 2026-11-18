# Design partners: discovery and pilot interview scripts

- **Checked:** 2026-11-12 (IST). Probes map to the gaps in [market-gaps.md](../market-gaps.md) §1 (G1–G10) and the P0
  bets in [feature-proposals.md](../feature-proposals.md) (#1–#8). The scripts are **proposals**.
- **Rules for the interviewer.** Ask about past behaviour, not hypotheticals ("last time", "walk me through"). Don't
  describe a feature before the person has described the problem. Don't suggest answers. Silence is fine. Never ask for
  customer names, client data or anything confidential. Take notes without names; use the role ("EM, SaaS, team of 12").
- **Interview recordings are separate from eval data.** Recording an interview is only for our notes. It never enters
  the Hindi-English eval set, and eval consent is asked only under
  [hinglish-eval-data-protocol.md](hinglish-eval-data-protocol.md).

## 0. Consent to record (read at the start, before recording)

Read this before pressing record. If the person says no, take written notes only.

> Before we start: may I record this conversation? The recording is only for our own notes, so that we don't miss what
> you say. Only the MeetOps product team will listen to it. We'll keep it for at most 90 days and then delete it, and
> we'll keep only written notes without your name. It won't be used to train or test any AI model. You can ask me to
> stop recording at any time, or ask us to delete it later by writing to [contact address]. You can also say no, and
> we'll just take notes. Is it OK to record?

- Wait for a clear "yes". Then start the recording and ask again so the consent is on the recording: "Just to confirm,
  you're OK with me recording?"
- If more than one person joins, ask each person.
- If anyone under 18 is present, don't record.
- **Proposal:** the 90-day period mirrors the ADR-019 default for raw recordings. **Decision needed** (Akash): the actual
  period, the contact address, and whether interview recordings are made at all. This consent covers MeetOps acting as
  Data Fiduciary for its own research (P4 in [dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §3), so the
  notice should meet DPDP s. 5 and Rule 3 once they apply (counsel to confirm the wording).

## 1. Discovery interview (45 minutes)

For champions and end users before the pilot. Economic buyers and IT/security get §2 and §3 as well.

**Context (5 min)**

1. Tell me about your role and your team. How many people, what do you build or deliver?
2. Which meetings did you have last week? Which of them ended with things people had to do?

**Last meeting walk-through (15 min)**

3. Think of the last meeting that ended with tasks. Walk me through what happened to those tasks after the meeting.
4. Who wrote them down? Where did they end up? How long did that take?
5. Was any task missed, given to the wrong person, or remembered differently by different people? What happened then?
   - Probe G4 / #1, #7: "How did you find out? What did it cost you?"
6. At the next meeting in that series, how did you check what had been done?
   - Probe G5 / #2: "What did you look at? How long did it take?"
7. How do tasks get from the meeting into Jira or GitHub today?
   - Probe G5 / #6: "Who does it? What gets lost?"

**Language (5 min; only if relevant)**

8. Which languages are spoken in your meetings? How often does one meeting mix languages?
   - Probe G6 / #5: "Have you used any transcription or notes tool in those meetings? What happened?"
   - Don't ask for samples here. Eval data is a separate, optional step.

**Recording and consent (10 min)**

9. Do you record any meetings today? Which ones, and with what?
10. How do participants find out a meeting is being recorded? Has anyone objected, or asked for a recording to be
    deleted? What happened?
    - Probe G1 / #3: "What about people from outside your company?"
11. Has a notes tool or bot ever joined meetings you didn't expect, or emailed people afterwards?
    - Probe G2 / #4: "Who noticed? What did you or IT do?"
12. How many of your meetings include people from a client or partner? Whose meeting tool do you use then?
    - Probe G9: "What can and can't you do in their tool?"

**Wrap-up (5 min)**

13. If you could change one thing about what happens after your meetings, what would it be?
14. Is there anything I should have asked and didn't?

## 2. Economic buyer add-on (15 minutes)

1. What do you pay for today for meetings, notes or task tracking? Who decided, and how?
2. How did you buy your last team tool? Card, UPI, invoice? Monthly or annual?
   - Probe ADR-017 and [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §4.1: "Who has to approve a recurring
     charge?"
3. What would you need to see at the end of a pilot to keep using it?
4. What would make you stop a pilot early?

- Don't quote prices. If asked, say pricing isn't set and that we'll share it at the end of the pilot.

## 3. IT / security / privacy add-on (20 minutes)

1. What do you check before a team can use a new tool that touches meeting content?
2. Walk me through the last tool you approved or rejected. What decided it?
3. Who in your company decides which meetings may be recorded?
   - Probe G2 / #4: "What control do you need over who records and who gets invited?"
4. How long do you keep recordings and transcripts today, if at all? Who asks for deletions?
   - Probe ADR-019 retention (7–365 days): "What period would your policy require?"
5. Where does your data have to be stored or processed? Is that a written rule, a client contract, or a preference?
   - Probe G8: "What happens if a vendor processes it outside India?"
6. What do you need from a vendor on breaches and sub-processors?
   - Probe the DPA outline ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §9, clauses 6–8).

- Don't make compliance claims. Follow the messaging rules in
  [gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §6.3.

## 4. Pilot interviews

### 4.1 Kick-off (week 0, 30 minutes, champion + buyer + IT)

1. Repeat the consent-to-record wording in §0.
2. Which meetings will you use it in? Which will you skip (external participants, sensitive topics)?
3. What does a good result look like for you in 8 weeks? (Record their words. These become the partner's own success
   criteria next to [pilot-success-metrics.md](pilot-success-metrics.md).)
4. Agree the baseline steps in [pilot-success-metrics.md](pilot-success-metrics.md) §2.

### 4.2 Check-in (weeks 2, 4 and 6, 20 minutes, champion)

1. Which meetings did you use it in since we last spoke? Which did you skip, and why?
2. Pick one meeting. Walk me through what you did with the draft action items.
   - Probe #1, #8: "Which drafts did you change? What was wrong? Did the quote help you decide?"
   - Probe #7: "Was the suggested owner right? How did you fix it when it wasn't?"
3. What happened to those items in Jira or GitHub afterwards?
   - Probe #6: "Did anything sync that shouldn't have, or fail to sync?"
4. At the next meeting in the series, did you look back at what was agreed last time? How?
   - Probe #2.
5. Did anyone ask about the recording, revoke consent, or ask for deletion? What happened?
   - Probe #3, ADR-020 decision 5.
6. (Mixed-language teams) How did the transcript and action items handle the languages spoken?
   - Probe #5: "Show me a place where it went wrong, if there is one."
7. What nearly made you stop using it this week?

### 4.3 Close-out (week 8, 30 minutes, champion + buyer)

1. Compared with the start, what has changed in how you handle tasks after meetings?
2. What did you stop using it for, and why?
3. The buyer: would you pay for this in INR? What would have to be true? (No price is quoted or agreed here.)
4. What should we fix first?
5. May we contact you about the paid beta? (Yes or no. Record the answer.)

## 5. After each interview

- Write notes within 24 hours, without names. Tag each finding with the gap or bet it relates to (G1–G10, #1–#8).
- Delete the recording at the end of the agreed period, or sooner if asked.
- Facts from interviews are anecdotes, not evidence of market size. Label them as such when quoted in other docs.

## 6. Decisions needed

- **Akash:** whether to record interviews at all, the retention period and contact address in §0, and who on the team
  may run interviews and listen to recordings.
