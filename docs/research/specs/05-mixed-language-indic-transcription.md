# Spec 5: Mixed-language and Indic transcription

- Proposal #5 in PR #468 (P0). Gap G6: Hindi-English (and other Indic-English) meetings transcribe badly or in one
  language only.
- Evidence: users report tools failing on "Hindi + English" (#468 S37). Gong transcribes a multi-language call in "the
  language spoken for the majority of the call" (verification-notes V3). Copilot's work/school language list has no Hindi
  (V8). Otter lists six languages, no Hindi (#468 S1). Zoom's meeting summary supports Hindi, Bengali, Tamil and Telugu
  (V7), so Indic _support_ alone isn't unique; **code-switching inside one transcript, plus Indic-aware action items**, is
  the angle.

## 1. User stories

1. As a **Bengaluru team lead**, our standups mix English and Hindi (or Kannada). I want one transcript that keeps both,
   and action items in English.
2. As an **admin**, I set our org's languages once (for example `en`, `hi`) and can override per meeting.
3. As a **reviewer**, I see each action item's quote in the original language, with an English rendering below it.
4. As a **finance owner**, I want Indic-heavy routing to stay within a budget.

## 2. UX flow

1. Org settings → **Languages**: spoken languages (multi-select), summary language (default English), "Indic routing"
   (off / auto / always), monthly cap in hours.
2. Before or during capture (extension popup, desktop, mobile) the host can change spoken languages for this meeting.
3. Transcript view shows a small language tag per segment when the provider returns one.
4. Summary and action items are in the summary language; quotes keep the original text (spec 1), with a translation
   toggle.

## 3. What the providers document (fetched 2026-11-11)

| Provider / model             | Code switching                                                                                                                                                                                                                                                   | Indic coverage                                                                                                                                          | Price (list)            | Source  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------- |
| AssemblyAI Universal-3.5 Pro | "natively handles code switching across 18 languages" with `language_detection: true`; `language_codes` constrains the set (mutually exclusive with `language_code` and `language_detection`); fallback via `speech_models: ["universal-3-5-pro","universal-2"]` | Hindi (English↔Hindi example on the page). Universal-3.6 Pro **Preview** adds Urdu and Marathi among 32. Other Indic languages on 3.5 Pro: not verified | $0.21/h                 | [I1–I3] |
| AssemblyAI Universal-2       | Legacy path: `language_detection_options.code_switching: true` (two languages, threshold `code_switching_confidence_threshold`, default 0.3)                                                                                                                     | 99 languages                                                                                                                                            | $0.15/h                 | [I1–I3] |
| Sarvam Saaras v4 (batch)     | `codemix` mode: "Transcribe code-mixed speech (e.g., Hindi-English) naturally"                                                                                                                                                                                   | 22 Indian languages + English; diarization; files up to 2 h; **chunk-level timestamps only** (not word-level)                                           | ₹0.49/min pay-as-you-go | [I4–I6] |

Deepgram is left out: `docs/PHASE_STATUS.md` records the product decision "AssemblyAI by default, optional faster-whisper, no
Deepgram, and no automatic paid fallback".

## 4. Data model and API sketch

Today:

- `packages/ai-core/src/adapters/assemblyai.ts` sends `speaker_labels` and **either** `language_code` **or**
  `language_detection: true`, plus `speech_models` when configured; it advertises languages `['en','hi','es','fr','de','auto']`.
- `apps/worker/src/ai/providers/assemblyai.ts` sends `speech_model` from `ASSEMBLYAI_SPEECH_MODEL` and the same language
  switch; it stores the returned `language_code`.
- `packages/ai-core/src/adapters/faster-whisper.ts` (local STT) takes one optional `language`, no diarization.
- Provider choice and credentials follow ADR-009 (routing, no paid fallback).
- In `packages/database/prisma/schema.prisma`, `Transcript` has one `language String?`; `TranscriptSegment` has no
  language column.

Proposed:

- Adapter input: `languages?: string[]`. Mapping: one language → `language_code`; several → `language_codes`
  (Universal-3.5 Pro); none → `language_detection: true`. Keep `speech_models: ['universal-3-5-pro','universal-2']` as the
  default fallback chain (per [I2]). Update the `capabilities()` language list from config, not a literal.
- New adapter `packages/ai-core/src/adapters/sarvam.ts` behind the same transcription interface
  (`apps/worker/src/ai/providers/transcription-provider.ts`), `mode: 'codemix'`. Because Sarvam returns chunk-level
  timestamps, segment ids and evidence still work (spec 1 cites segments, not words).
- Migration: `TranscriptSegment.language String?` (new). `Transcript` already has `language String?`; add
  `languages String[]` for code-switched files.
- Org config in `AiOrganizationConfig.config` (JSON, existing): `{ spokenLanguages: string[], summaryLanguage: string,
indicRouting: 'off'|'auto'|'always', indicMonthlyCapHours: number }`. Contracts: an `AiLanguageSettings` type (ADR-003).
- Meeting override: `apps/api/src/modules/meetings/http/meetings.routes.ts` has GET/POST only today (no update route).
  Add `spokenLanguages` to the create body, plus a new `PUT /orgs/:organizationId/meetings/:meetingId/languages` before
  processing starts (validated against the provider's language codes).
- Usage: count Sarvam minutes in `AiUsageCounter`; refuse routing over the cap and fall back to AssemblyAI (no silent
  paid fallback beyond ADR-009 rules).

## 5. AI approach

- **Routing (`auto`, only when an admin has enabled Indic routing):** if the org's spoken languages include an Indic language other than Hindi, or AssemblyAI returns low
  confidence on a Hindi-English file, route to Sarvam `codemix` (cap permitting). Otherwise Universal-3.5 Pro with
  `language_codes`.
- **Extraction:** the map prompt (`meeting-map@2`, spec 1) gets `summaryLanguage` and an instruction to keep quotes
  verbatim; summaries are written in the summary language.
- **Evaluation:** build a small labelled set (≥5 hours) of consented internal Hindi-English and one other Indic-English
  meeting; measure WER/CER per provider and action-item precision. No numbers exist yet; we don't claim accuracy.
- Script: allow Devanagari or romanised output per org (Sarvam documents `translit`/`codemix` modes; AssemblyAI keeps what
  was said). Decide default with pilot users.

## 6. Risks

- **Cost:** Sarvam at ₹0.49/min is far above AssemblyAI's $0.21/h list price (see [../pricing-packaging.md](../pricing-packaging.md)
  §3). Mitigation: caps, Business tier only, auto-routing only on need.
- **Product decision needed:** adding Sarvam is a new paid provider. Routing to it must be an explicit org setting, never an
  automatic paid fallback (`docs/PHASE_STATUS.md`, ADR-009).
- **Preview models:** Urdu and Marathi come with Universal-3.6 Pro Preview; don't depend on preview models for GA.
- **Diarization quality varies by provider**, which affects spec 1 owners. Measure it in the eval.
- **Data residency:** a new sub-processor (Sarvam) must go into the DPA and the sub-processor list (ADR-019
  consequences); delete provider copies after processing (ADR-019).
- **BIPA/AI Act:** same diarization questions as today (legal brief §2, §3).

## 7. Success metrics (targets are estimates)

- WER on the internal Hindi-English set improves against today's `language_detection` baseline (measure first).
- ≥90% of code-switched segments keep both languages (manual sample of 200 segments).
- Action-item precision on Indic-English meetings within 5 points of English-only meetings.
- Indic routing spend stays under the org cap 100% of the time.

## 8. Effort per team (estimates)

| Team        | Work                                                                                  | Estimate |
| ----------- | ------------------------------------------------------------------------------------- | -------- |
| AI          | `language_codes` mapping, Sarvam adapter, routing rule, prompt changes, eval set      | 2.5–3 ew |
| Backend     | Migration, settings contracts, meeting override, usage cap                            | 1.5–2 ew |
| Frontend    | Language settings, per-segment tags, translation toggle                               | 1 ew     |
| Native      | Per-meeting language picker in extension, desktop and mobile                          | 0.5–1 ew |
| QA/security | Provider contract tests, SSRF/credential checks per ADR-009, cap tests, DPA checklist | 1 ew     |

Blocked on the owner: real provider keys for the eval (`docs/PHASE_STATUS.md`: "Keys via secure input: Gemini, AssemblyAI"),
and a product decision to add Sarvam as a provider.

## Sources (fetched 2026-11-11)

| ID  | URL                                                                      |
| --- | ------------------------------------------------------------------------ |
| I1  | https://www.assemblyai.com/docs/pre-recorded-audio/code-switching        |
| I2  | https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages   |
| I3  | https://www.assemblyai.com/pricing                                       |
| I4  | https://docs.sarvam.ai/api/getting-started/models                        |
| I5  | https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api |
| I6  | https://www.sarvam.ai/api-pricing                                        |
