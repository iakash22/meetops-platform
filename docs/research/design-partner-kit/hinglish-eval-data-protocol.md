# Hindi-English eval data: consent and handling protocol

- **Checked:** 2026-11-12 (IST). Repo paths are at `integration/phase-1` `d50d0dc2`. Law is cited from the DPDP Act,
  2023 and the DPDP Rules, 2025 (G.S.R. 846(E)) as read in [dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md)
  [D1, D3 there]. Everything in this protocol is a **proposal**. Our readings of the law are labelled **interpretation**.
  It is not legal advice; counsel should review the consent text before any data is collected.
- **Status.** No eval data has been collected. Spec 05 asks for "a small labelled set (≥5 hours) of consented internal
  Hindi-English and one other Indic-English meeting" ([specs/05](../specs/05-mixed-language-indic-transcription.md) §5).
  This protocol covers Hindi-English only.

## 1. Purpose and role

- **Purpose (the only one).** Measure how well MeetOps transcribes, summarises and extracts action items from meetings
  that mix Hindi and English: WER/CER for speech-to-text, and action-item and decision precision/recall
  ([pilot-success-metrics.md](pilot-success-metrics.md) M15).
- **Not allowed:** training or fine-tuning any model (ours or a vendor's); product analytics; marketing; any use to judge
  individual employees; sharing with the participant's employer. A new purpose needs new consent (DPDP s. 6(1): consent
  is "limited to such personal data as is necessary for such specified purpose").
- **Role (interpretation).** Using customer meeting content for MeetOps' own benchmarking moves MeetOps towards Data
  Fiduciary for that data ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §3, P1). So MeetOps must
  collect consent itself, from each speaker, and can't rely on the customer's recording notice or the ADR-020 host
  attestation.
- **Timing.** DPDP ss. 5–6 and Rule 3 apply from 13 May 2027 (our computed date,
  [dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §1). This protocol follows them now.

## 2. Consent model

1. **Separate from product consent.** ADR-020 governs recording a meeting in the product: all-party notice by default,
   explicit consent if the org asks, capture stops on `consent_revoked`
   ([ADR-020](../../15-decisions/ADR-020-recording-consent.md)). Eval consent is a second, optional consent with its own
   form and its own register. It is not stored in `consent_attestations` or `meeting_consent_events`, which record the
   host's attestation and per-meeting events for product capture (`packages/database/prisma/schema.prisma`, models
   `ConsentAttestation` and `MeetingConsentEvent`).
2. **Per speaker, every speaker.** Each person who speaks in an eval meeting gives their own consent. If any speaker says
   no, or can't be asked, the whole meeting is left out. We don't cut one person's speech out, because the others'
   words and the summary still reflect it (**proposal**).
3. **Adults only.** Each speaker confirms they are 18 or older. A meeting where a child speaks or is present is left out,
   and if one is found later, it is deleted. DPDP s. 9(1) requires verifiable parental consent for a child's data
   ([dpdp-role-and-dpa-outline.md](../dpdp-role-and-dpa-outline.md) §6); this protocol avoids children's data entirely.
4. **Free and unconditional.** No incentive is tied to eval consent, and the pilot never depends on it (s. 6(1)). The
   partner org is not told which of its staff agreed or declined (**proposal**, to keep consent free of employer
   pressure).
5. **Clear affirmative action.** An unticked box the person ticks themselves, or a signed form. Silence or staying in a
   meeting is not consent (s. 6(1)).
6. **Notice contents (Rule 3).** The form below is the notice. It gives an itemised description of the data, the specific
   purpose, the link to withdraw "with the ease of doing so being comparable" to giving consent, how to exercise rights,
   and how to complain to the Data Protection Board (Rule 3(b)–(c); s. 6(4)). It gives the contact of the person who
   answers requests (s. 6(3)).
7. **Language.** English and Hindi, so each person can read it in either (s. 5(3), s. 6(3) allow English or any
   Eighth Schedule language).
8. **Withdrawal.** Any time, through the same channel used to consent. We stop using the person's data and delete it
   within the period in §5. Results computed before withdrawal stay valid (s. 6(5)), but we recompute any stored
   aggregate that could still identify them (**proposal**).

## 3. Consent wording

### 3.1 English

> **MeetOps: consent to use your voice and words to test our Hindi-English features**
>
> This is separate from the recording notice for the meeting. It is optional. Saying no changes nothing about your use
> of MeetOps or your company's pilot, and your company won't be told whether you said yes or no.
>
> **What we would use:** the audio of what you say in [meeting or session], the transcript of it, and the label that
> marks which speaker you are.
>
> **Why:** only to test how accurately MeetOps transcribes and summarises meetings that mix Hindi and English. We will
> not use it to train any AI model, for marketing, or to judge anyone's work.
>
> **What we do with it:** we remove names, numbers and other details that identify people from the transcript. A small,
> named MeetOps team can listen to the audio to check the transcript. The audio is sent to [speech-to-text provider],
> in [location], only to run the test, under terms that don't allow it to train on the audio.
>
> **Where and how long:** stored in [storage location]. Audio is deleted within [period]. The cleaned transcript is kept
> for up to [period] and then deleted.
>
> **Your choices:** you can withdraw at any time at [link or email], as easily as you agreed. We will stop using your
> data and delete it within [period]. You can also ask to see, correct or delete it, or complain to us at [contact], or
> to the Data Protection Board of India.
>
> ☐ I am 18 or older.
>
> ☐ I agree that MeetOps may use my voice and words from [meeting or session] for this testing, as described above.
>
> Name: \_\_\_\_\_\_ Date: \_\_\_\_\_\_

### 3.2 Hindi (हिंदी): **needs native-speaker review before use**

The Hindi below is our draft translation. A native Hindi speaker and counsel must review it before it is used.

> **MeetOps: हमारी हिंदी-अंग्रेज़ी सुविधाओं की जाँच के लिए आपकी आवाज़ और शब्दों के उपयोग की सहमति**
>
> यह मीटिंग की रिकॉर्डिंग सूचना से अलग है। यह वैकल्पिक है। "नहीं" कहने से MeetOps के आपके उपयोग या आपकी कंपनी के
> पायलट पर कोई असर नहीं पड़ेगा, और आपकी कंपनी को यह नहीं बताया जाएगा कि आपने "हाँ" कहा या "नहीं"।
>
> **हम क्या उपयोग करेंगे:** [मीटिंग या सत्र] में आपकी कही बातों की ऑडियो, उसका ट्रांसक्रिप्ट, और वह लेबल जो बताता है कि
> कौन-सा वक्ता आप हैं।
>
> **क्यों:** केवल यह जाँचने के लिए कि MeetOps हिंदी और अंग्रेज़ी मिली-जुली मीटिंग को कितनी सही तरह लिखता और सारांशित
> करता है। हम इसका उपयोग किसी AI मॉडल को प्रशिक्षित करने, मार्केटिंग, या किसी के काम का मूल्यांकन करने के लिए नहीं
> करेंगे।
>
> **हम इसके साथ क्या करेंगे:** हम ट्रांसक्रिप्ट से नाम, नंबर और लोगों की पहचान बताने वाली अन्य जानकारी हटा देंगे। MeetOps
> की एक छोटी, नामित टीम ट्रांसक्रिप्ट जाँचने के लिए ऑडियो सुन सकती है। ऑडियो केवल जाँच चलाने के लिए [स्पीच-टू-टेक्स्ट
> प्रदाता] को [स्थान] में भेजी जाएगी, ऐसी शर्तों पर जो उसे इस ऑडियो पर प्रशिक्षण की अनुमति नहीं देतीं।
>
> **कहाँ और कितने समय तक:** [संग्रहण स्थान] में रखा जाएगा। ऑडियो [अवधि] के भीतर हटा दी जाएगी। साफ़ किया गया
> ट्रांसक्रिप्ट अधिकतम [अवधि] तक रखा जाएगा और फिर हटा दिया जाएगा।
>
> **आपके विकल्प:** आप किसी भी समय [लिंक या ईमेल] पर अपनी सहमति वापस ले सकते हैं, उतनी ही आसानी से जितनी आसानी से आपने
> सहमति दी थी। हम आपके डेटा का उपयोग बंद कर देंगे और उसे [अवधि] के भीतर हटा देंगे। आप इसे देखने, सुधारने या हटाने का
> अनुरोध भी कर सकते हैं, या [संपर्क] पर हमसे, या भारतीय डेटा संरक्षण बोर्ड से शिकायत कर सकते हैं।
>
> ☐ मेरी आयु 18 वर्ष या उससे अधिक है।
>
> ☐ मैं सहमत हूँ कि MeetOps ऊपर बताए अनुसार इस जाँच के लिए [मीटिंग या सत्र] से मेरी आवाज़ और शब्दों का उपयोग कर सकता है।
>
> नाम: \_\_\_\_\_\_ तारीख़: \_\_\_\_\_\_

Brackets are filled in from the decisions in §10 before use. "Data Protection Board of India" is the body the Act
establishes (s. 18); check the Hindi name against the Hindi text of the Act during review.

## 4. De-identification

### 4.1 Audio

- Raw audio can't be fully de-identified: a voice can identify a person. Treat all eval audio as personal data for its
  whole life (**interpretation**).
- Keep only the meetings and spans needed for the eval. Trim pre-meeting chatter and anything off-topic.
- Mask spoken names, phone numbers, email addresses, ID numbers (Aadhaar, PAN, account numbers) and client names with a
  tone or silence, and mark those spans "not scored" so masking doesn't distort WER (**proposal**; the effect on WER
  must be measured).
- Don't create or store speaker embeddings or voiceprints ourselves. If diarization is used, only the vendor's speaker
  labels are kept. AssemblyAI's Biometric Data Addendum puts notice and consent duties on the customer when diarization
  is used ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §2.3; counsel question 9 in
  [legal-questions-brief.md](../legal-questions-brief.md)), so the consent above names the speaker label.
- Strip file metadata (device, location, creation tags) before storage.

### 4.2 Transcripts

1. A reviewer produces a verified reference transcript from the audio.
2. Replace speakers with `SPEAKER_A`, `SPEAKER_B`… and every other person named in speech with `PERSON_1`, `PERSON_2`…,
   consistently within a meeting. Replace organisations and clients with `ORG_1`…, products and project code names with
   `PROJECT_1`….
3. Replace emails, phone numbers, URLs, ID numbers, amounts tied to a person, street addresses and places smaller than a
   city with type tokens (`[EMAIL]`, `[PHONE]`, `[ID]`, `[URL]`, `[ADDRESS]`).
4. Shift absolute dates to relative ones ("next Thursday" stays; "14 March" becomes `[DATE]`) unless the date is a due
   date that the action-item golden needs; then shift all dates in the meeting by the same offset.
5. A second reviewer checks the result for indirect identifiers (job titles unique to one person, rare events, health or
   family details) and removes or generalises them.
6. Keep **no** re-identification key. The only link from data to a person is the random speaker ID in the consent
   register (§6), which exists so that withdrawal works.
7. Record what was done in a de-identification log per meeting (counts of replacements by type, reviewer IDs, date). The
   log never contains the original values.

**Interpretation.** Even after these steps, a transcript of a real meeting may still identify people to their
colleagues. Treat de-identified transcripts as personal data too, and keep them under §5–§7.

## 5. Retention and deletion (proposal)

| Data                                          | Retention (proposal)                                                                                                                  | Deletion                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed consent forms and the consent register | For as long as any of the person's data is held, then [period for counsel] as proof of consent                                        | Manual, logged                                                                                                                                                                |
| Raw audio (masked)                            | **OPTION A:** 90 days (mirrors the ADR-019 default for recordings). **OPTION B:** up to 12 months, to compare STT providers over time | Bucket lifecycle rule plus a manual check                                                                                                                                     |
| Vendor copies of eval audio and transcripts   | Deleted right after each run, as ADR-019 promises for provider copies                                                                 | Provider delete call (**not built**, [ai-provider-due-diligence.md](../ai-provider-due-diligence.md) §1) or a short TTL (≥ 1 h on AssemblyAI paid plans, §5.5 OPTION A there) |
| Verified, de-identified reference transcripts | Up to 24 months, reviewed every 12 months; earlier if the purpose is served (s. 8(7)(a))                                              | Delete from the eval store and any local copies                                                                                                                               |
| Eval results                                  | Aggregate scores only (no text); kept                                                                                                 | —                                                                                                                                                                             |
| Access and processing logs                    | At least 1 year (Rule 8(3), as in ADR-019)                                                                                            | Rolling                                                                                                                                                                       |
| **On withdrawal**                             | Stop use at once; delete the person's audio, the meetings they spoke in, and derived transcripts within 30 days                       | Logged; confirmation sent to the person                                                                                                                                       |

Because withdrawal removes whole meetings, **no consented-derived data may be committed to git**: git history can't be
cleaned reliably (§8).

## 6. Access control (proposal)

| Role                                 | Consent register | Raw audio                | De-identified transcripts | Eval results               | Notes                                             |
| ------------------------------------ | ---------------- | ------------------------ | ------------------------- | -------------------------- | ------------------------------------------------- |
| Akash (owner)                        | Read             | No (by default)          | Read                      | Read                       | Approves use of the set and any change of purpose |
| AI Engineer (eval owner)             | No               | Read                     | Read / write              | Read / write               | Runs evals; manages the eval store                |
| Annotator / first reviewer           | No               | Read (assigned meetings) | Write (assigned meetings) | No                         | Under a confidentiality undertaking               |
| Second reviewer                      | No               | No                       | Read / comment            | No                         | Checks de-identification                          |
| Pilot lead (consent and withdrawals) | Read / write     | No                       | No                        | No                         | Only role that can link a person to a speaker ID  |
| Other engineers                      | No               | No                       | No                        | Read                       | Synthetic fixtures in git only                    |
| Design-partner org                   | No               | No                       | No                        | Aggregate only, on request | Never told who consented                          |
| Approved STT vendor                  | No               | Per run, deleted after   | No                        | No                         | See §7                                            |
| Counsel                              | On request       | No                       | On request                | On request                 |                                                   |

All access is through named accounts with MFA, logged, and reviewed every quarter. Remove access when someone leaves the
role.

## 7. Storage location and providers

**Storage (proposal).**

- A separate private bucket for eval data, not the product media bucket, so product retention jobs and eval retention
  stay apart.
- The storage package supports `STORAGE_PROVIDER` `minio|neon|r2|s3`, and the default region is `us-east-1` for S3 when
  `STORAGE_REGION` is unset (`packages/storage/src/config.ts` L80–L111). The eval bucket must set its region explicitly:
  **an India region** is proposed (**Decision needed**, Akash: provider and region).
- Check that the bucket is private at start-up, as the product bucket does (`S3StorageService.verifyBucketPrivate()`,
  `packages/storage/src/s3-storage.ts` L1047, and the fail-closed gate described in
  `packages/storage/src/download-headers.ts` L41–L45). Encrypt at rest, and add a lifecycle rule for the audio retention.
- The consent register is a separate, access-restricted store, not the eval bucket (**Decision needed**, Akash: which).
- No copies on laptops except encrypted, temporary working copies deleted after each annotation task.

**Which providers may see eval data (proposal, from [ai-provider-due-diligence.md](../ai-provider-due-diligence.md)).**

| Provider                 | Eval audio?      | Eval text?       | Condition                                                                                                                                                                                             |
| ------------------------ | ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AssemblyAI               | Yes              | Yes              | Paid plan with training opt-out and a short TTL (§5.5 OPTION A), or the EU endpoint, which AssemblyAI says is never used for training (§5.5 OPTION B). Not on a free plan, which can't opt out (§2.3) |
| Gemini API, paid tier    | No               | Yes              | Paid tier only: no training on paid-tier data, but abuse logs may be kept "in any country" (§2.1, §5.1 OPTION A)                                                                                      |
| Gemini API, unpaid tier  | No               | **No**           | Google uses unpaid-tier content to improve its products (§2.1)                                                                                                                                        |
| Vertex AI                | No               | Yes, if built    | Only once an adapter exists (§5.1 OPTION B or C)                                                                                                                                                      |
| Sarvam                   | **No (for now)** | **No (for now)** | Default training and retention not verified (§6 Q6 there) and no Sarvam spend until Akash sets a budget ([gtm-india-smb-midmarket.md](../gtm-india-smb-midmarket.md) §5)                              |
| Azure OpenAI, OpenAI API | No               | No               | No adapter in the repo (§1 there)                                                                                                                                                                     |

**Decision needed** (Akash with the AI Engineer): confirm this list; in particular which AssemblyAI option, and whether
any Indic provider joins once its terms are verified.

## 8. How data enters the AI eval fixtures

**What exists today (read from the repo).**

- `apps/worker/eval/` is an offline, text-only eval of the production summary and action-item prompts: `harness.ts`,
  `mock-llm.ts`, `score.ts`, `worker-eval.eval.ts` and `fixtures/*.json` (`standup`, `planning`, `noisy-no-actions`,
  `adversarial`). It runs with `pnpm --filter @meetops/worker eval` and is excluded from `pnpm test`
  (`apps/worker/vitest.config.mjs`; `apps/worker/eval/vitest.config.mjs`; `docs/09-ai/ai-evaluation.md` "Worker eval").
- A fixture is `{ name, description, transcript: SummaryTranscript, golden }`, where the transcript has `language` and
  `segments` with `speakerLabel`, `startMs`, `endMs` and `text` (`apps/worker/eval/harness.ts`;
  `apps/worker/src/ai/summary-repository.ts` L17–L23).
- Every `*.json` in `apps/worker/eval/fixtures/` is loaded automatically (`apps/worker/eval/worker-eval.eval.ts`
  L9–L13), and the fixtures are committed to git.
- The model is a deterministic, rule-based mock that matches English patterns such as `<Name> will <task>` and
  `we decided` (`apps/worker/eval/mock-llm.ts` L14–L15, L70, L81). Hindi-English phrasing will mostly test the mock,
  not a model.
- `score.ts` normalises text with `.replace(/[^a-z0-9 ]+/g, ' ')` (L12), which deletes every Devanagari character, and
  treats two empty token sets as a perfect match (L22). A Devanagari golden title would therefore match any Devanagari
  prediction (**finding** for the AI Engineer).
- `packages/ai-core/eval/` is a second text-only eval for the ai-core pipeline (`docs/09-ai/ai-evaluation.md`).
- **There is no speech-to-text or audio eval** anywhere in `apps/worker` or `packages/ai-core`. `apps/worker/test/fixtures/media/`
  holds media files for media-pipeline tests (tones and truncated files), not speech.

**Proposed flow (needs the AI Engineer; code changes are outside docs/research and not made here).**

1. **Collect** under §2–§3, store raw audio in the eval bucket (§7).
2. **Transcribe and verify** a reference transcript, then **de-identify** it (§4). Pick one script convention for Hindi
   (Devanagari or Roman) per segment and record it.
3. **Convert** each meeting to the existing fixture shape (`SummaryTranscript` plus `golden` action items and
   decisions), with `language` set to the dominant language code the transcript schema accepts
   (`^[a-z]{2}(_[a-z]{2})?$`, `apps/worker/src/ai/recording-transcription.ts` L30).
4. **Keep consented-derived fixtures out of git.** Store them in the eval bucket. A proposed loader reads them from a
   local directory named by an environment variable (for example `EVAL_DATA_DIR`) and skips the suite when it isn't
   set. That directory is git-ignored. Only **synthetic** Hindi-English fixtures, written by the team and not taken
   from real meetings, go into `apps/worker/eval/fixtures/`.
5. **Proposed STT eval:** a new `apps/worker/eval/stt/` (does not exist) that sends eval audio to an approved provider
   (§7), computes WER and CER against the reference, and stores only aggregate scores. Manual runs only, outside CI,
   in line with "Real-model runs (live keys, rubric scoring) stay out of CI" (`docs/09-ai/ai-evaluation.md`).
6. **Fix scoring for Hindi** before using any Devanagari golden: Unicode-aware tokenisation in `score.ts`, and WER/CER
   normalisation rules (script, punctuation, numerals, Hindi-English transliteration variants).
7. **Delete** vendor copies after each run (§5), and honour withdrawals by deleting the affected fixtures from the eval
   bucket and any local copies.

## 9. Alignment check

| Requirement                                                                          | Where it is met                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| ADR-020 all-party recording consent                                                  | Eval meetings are recorded under ADR-020 first; eval consent is extra (§2.1)     |
| DPDP purpose limitation (s. 6(1))                                                    | One stated purpose; no training, marketing or employee assessment (§1)           |
| DPDP s. 6 consent and withdrawal                                                     | Free, specific, affirmative, per speaker; withdrawal as easy as consent (§2, §3) |
| Rule 3 notice                                                                        | Consent form items (§2.6, §3)                                                    |
| Children excluded                                                                    | 18+ confirmation; meetings with children left out (§2.3)                         |
| Erasure when purpose ends or consent is withdrawn (s. 8(7))                          | Retention table and withdrawal (§5)                                              |
| No vendor training ([ai-provider-due-diligence.md](../ai-provider-due-diligence.md)) | Provider list with training conditions (§7)                                      |
| ADR-019 provider-copy deletion                                                       | Required per run; provider delete call not built yet (§5)                        |

## 10. Decisions needed

**Akash**

1. Collection mode: **OPTION A** dedicated eval sessions (staff or partner volunteers holding realistic work meetings),
   lower risk; **OPTION B** selected real pilot meetings where every speaker consents; or both.
2. Raw audio retention: OPTION A 90 days or OPTION B up to 12 months (§5).
3. Storage provider and India region for the eval bucket, and where the consent register lives (§7).
4. The provider list for eval audio and text, especially the AssemblyAI option (§7).
5. Who holds each role in §6.
6. Fill-ins for the consent form: contact, withdrawal link, periods (§3).
7. Whether any thank-you to individuals is offered (recommended: none; counsel question).

**AI Engineer**

1. Scoring for Hindi: Unicode-aware tokenisation in `apps/worker/eval/score.ts` and WER/CER normalisation (§8 step 6).
2. The out-of-git fixture loader and `EVAL_DATA_DIR` convention (§8 step 4).
3. The STT eval under `apps/worker/eval/stt/` and which real-model runs to do (§8 step 5).
4. Whether the summary and action-item eval should run Hindi-English fixtures against a real paid model, since the mock
   only matches English patterns (§8).
5. Audio masking and its effect on WER (§4.1).

**Counsel:** whether the consent form and Hindi text meet s. 5, s. 6 and Rule 3; whether de-identified transcripts can
be kept after a speaker withdraws if they no longer identify them; and the retention period for consent records. These
are now questions 26–28 in [legal-questions-brief.md](../legal-questions-brief.md) §5.
