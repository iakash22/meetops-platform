# AI provider due diligence: Gemini, Vertex AI, AssemblyAI, Azure OpenAI, OpenAI API, Sarvam

> **Checked:** 2026-11-12 (IST). Public pages only: no sign-ups, no API keys, no spend and no calls to any vendor API.
> Each vendor fact below cites a source ID from [Sources](#sources), with the page's own "last updated" date where the
> page shows one. Cost figures are **ESTIMATES** (ours), with the inputs and formula shown. Where this doc suggests a
> choice it is a labelled **OPTION**: the Gemini tier for customer data, the PII redaction policy, the embeddings
> provider and the AI budgets are **Akash's decisions**, and none of them is decided here. Legal points are inputs for
> counsel, not legal advice (see [legal-questions-brief.md](legal-questions-brief.md) §5).

## 1. The pipeline we actually run

The matrix in §3 uses these stages, read from the repo at `integration/phase-1` base `8b881166` (the cited code and ADR files are unchanged from `70f2ffb0`,
where they were first read):

| #   | Stage                                 | What the code does                                                                                                                                                                                                                                                                                                                                                                                                                 | Files                                                                                                                                                                                               |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Batch speech-to-text with diarization | Media is cut into chunks (`MEDIA_CHUNK_SECONDS`, default 600 s). Each chunk is uploaded to AssemblyAI `/v2/upload` and transcribed via `POST /v2/transcript` with `speech_model` (default `'universal'`, env `ASSEMBLYAI_SPEECH_MODEL`), `language_code` or `language_detection: true`, and `speaker_labels`. Diarization is **on by default** (`speakerLabels: deps.speakerLabels ?? true`). The worker polls or takes a webhook. | `apps/worker/src/ai/providers/assemblyai.ts`, `apps/worker/src/ai/recording-transcription.ts` L153, `apps/worker/src/ai/env.ts` L75, `packages/ai-core/src/adapters/assemblyai.ts` L62              |
| S2  | Meeting summary (LLM, one pass)       | Gemini `generateContent` (`v1beta`), default model `gemini-2.5-flash-lite`, JSON output, temperature 0.2, host allowlist `generativelanguage.googleapis.com`. Transcripts over `maxTranscriptChars` 200,000 are refused, not truncated; `maxOutputTokens` 8192.                                                                                                                                                                    | `apps/worker/src/ai/providers/gemini.ts`, `apps/worker/src/ai/meeting-summary.ts` L63, `apps/worker/src/ai/summary-worker.ts`                                                                       |
| S3  | Action-item extraction (LLM)          | Feature `'actions'`, temperature 0.1, `maxTokens` 4096, one bounded repair retry, drafts saved as `pending_review`.                                                                                                                                                                                                                                                                                                                | `apps/worker/src/ai/action-items.ts` L140–L182                                                                                                                                                      |
| S4  | Embeddings (semantic search)          | **Off by default** (`SEMANTIC_EMBEDDINGS_ENABLED`). When on, embeds transcript segments and summary reports (batch 32, up to 2,000 sources per job, content-hash skip) into `vector(1536)`, at most 8,000 chars per input. No default provider has the embeddings capability; phase-7 notes say it needs "an approved, non-free-tier provider".                                                                                    | `apps/worker/src/embeddings/pipeline.ts`, `apps/worker/src/embeddings/index.ts` L30, `docs/plans/phase-7-notes.md` L67, L76, L83                                                                    |
| —   | Routing, budgets and credentials      | Default route is Gemini Flash-Lite plus AssemblyAI; no implicit fallback and no free→paid fallback unless `AI_ALLOW_PAID_FALLBACK`; per-org `monthlyBudgetUsd`; credentials by reference; SSRF host allowlist. ADR-009 status is Proposed.                                                                                                                                                                                         | `docs/15-decisions/ADR-009-ai-provider-routing-credentials-ssrf.md`, `packages/ai-core/src/router.ts` L77, `packages/ai-core/src/bootstrap.ts` L42–L72, `packages/ai-core/src/security/ssrf.ts` L89 |
| —   | Retention promise                     | ADR-019 table: "AI provider copies (AssemblyAI, Gemini): Deleted at the provider right after processing".                                                                                                                                                                                                                                                                                                                          | `docs/15-decisions/ADR-019-media-retention.md` L31                                                                                                                                                  |
| —   | Consent                               | ADR-020: all-party consent, notice-based by default, explicit consent for EU/UK, legal review before GA.                                                                                                                                                                                                                                                                                                                           | `docs/15-decisions/ADR-020-recording-consent.md`                                                                                                                                                    |
| —   | Indic route (proposed, not built)     | Spec 05 proposes Sarvam Saaras `codemix` as an opt-in, capped route for Hindi-English orgs. No Sarvam adapter exists in `apps/` or `packages/`.                                                                                                                                                                                                                                                                                    | `docs/research/specs/05-mixed-language-indic-transcription.md`, `docs/research/pricing-packaging.md` §3                                                                                             |

What the repo shows that matters for this review:

- **Both defaults are labelled free tier.** `bootstrap.ts` L50 gives Gemini `cost: { tier: 'free' }` with
  `dailyRequestLimit: 1000`; L55 gives AssemblyAI `tier: 'free'` with `monthlyAudioSecondsLimit: 5 * 3600`. These are
  routing labels in our code. The vendor's own plan is set on the vendor account, which we can't see. But both vendors'
  free plans have the weakest data terms (§2.1, §2.3), and phase-7 notes already say "the free Gemini tier must not
  process customer data".
  _Correction 2026-11-18 (after #513, `1d7ba360`): the labels are now at L66 (Gemini) and L81 (AssemblyAI). Production now refuses free or undeclared
  LLM/STT tiers unless `AI_PROVIDER_DATA_TIER_<NAME>` is `paid` or `no-training` (b8eb5ffb;
  `packages/ai-core/src/provider-data-tier.ts` L108–125)._
- **No provider deletion call exists.** There is no `DELETE /v2/transcript/:id` (or any delete) in `apps/worker` or
  `packages/ai-core`, so the ADR-019 promise above is not implemented. AssemblyAI keeps transcripts 30 days by default
  (§2.3). This is a code change, outside docs/research; listed in §7 for the coordinator.
  _Correction 2026-11-18 (after #513, `1d7ba360`): 45e8664e added a DELETE after durable store (`packages/ai-core/src/adapters/assemblyai.ts` L191;
  `apps/worker/src/ai/provider-transcript-delete.ts`). There is no sweep for final failures, no backfill, and no
  Gemini delete._
- **No content PII redaction exists before the LLM.** `redact()` in `packages/ai-core/src/audit.ts` L25 only masks
  secret keys in audit records. Transcripts go to the summary and action-item model as they are.
- **Hosts.** At base `8b881166`, `DEFAULT_ALLOWED_HOSTS` in `packages/ai-core/src/security/ssrf.ts` L89 lists four
  hosts: `generativelanguage.googleapis.com`, `api.assemblyai.com`, `api.openai.com` and `api.deepgram.com`. The project
  lead says the last entry is being removed from the code; it is not a provider assessed in this doc. The Gemini adapter
  uses `generativelanguage.googleapis.com` only. None of the four is a Vertex AI, Azure OpenAI, Sarvam or AssemblyAI EU
  (`api.eu.assemblyai.com`) host, so each of those would need adapter and allowlist work.
  _Correction 2026-11-18 (after #513, `1d7ba360`): 088dab3e removed `api.deepgram.com`. The list is now three hosts (`ssrf.ts` L122–125)._

## 2. Findings per provider

### 2.1 Gemini API (Google AI Studio, paid vs unpaid)

- **Training.** Unpaid Services: Google uses submitted content to improve its products, human reviewers may read it, and
  the terms say "Do not submit sensitive, confidential, or personal information to the Unpaid Services". Paid Services:
  Google "doesn't use your prompts … or responses to improve our products" and processes them under the Data Processing
  Addendum for Products Where Google is a Data Processor [G1, G9]. The pricing page repeats "Used to improve our
  products: Yes (free) / No (paid)" [G5].
- **Retention.** Paid Services: Google "logs prompts and responses for a limited period of time, solely for detecting and
  preventing violations of the Prohibited Use Policy", and the data "may be stored transiently or cached in any country"
  [G1]. The ZDR page says: "If your workload requires guaranteed zero data retention or enterprise data processing
  agreements, use Vertex AI." Grounding data is kept 30 days with no opt-out; File API data is kept until deleted; the
  implicit in-memory cache has a 24 h TTL and "does not violate ZDR" [G2]. AI Studio logs (if logging is enabled) are
  kept 55 days by default, configurable to 7/14/28/55 [G3].
- **EEA/UK/CH.** Only Paid Services may be used when serving users in the EEA, Switzerland or the UK [G1].
- **Regions.** India is on the list of available countries [G4]. There is no regional processing option: the terms allow
  storage or caching "in any country" [G1].
- **DPA and sub-processors.** Paid use is under Google's processor terms [G9]; the Google Cloud sub-processor list was
  last modified 19 Oct 2026 [G8].
- **Stages offered.** S2, S3, S4 (gemini-embedding-001 / gemini-embedding-2). We don't use Gemini for S1, so diarization,
  voiceprints and code-switching are not assessed for it.
- **List prices** (paid, per 1M tokens) [G5]: `gemini-2.5-flash-lite` $0.10 input (text), $0.30 audio, $0.40 output;
  batch $0.05 / $0.20. `gemini-embedding-001` $0.15 input (batch $0.075); `gemini-embedding-2` text $0.20.
- **Embeddings fit.** Default 3,072 dimensions; 768, 1,536 or 3,072 recommended. Non-3,072 outputs from
  `gemini-embedding-001` must be normalised by the caller; `gemini-embedding-2` normalises automatically [G6]. Our column
  is `vector(1536)`.

### 2.2 Vertex AI (now branded "Gemini Enterprise Agent Platform")

- **Training.** Google won't use customer data to train or fine-tune models without permission ("training restriction")
  [V1].
- **Retention and ZDR.** Prompt logging for abuse monitoring applies under the Google Cloud terms §4.3; the implicit
  in-memory cache and the durable cache are both deleted within 24 h; the durable cache stays in the selected region on
  regional endpoints but not on the global endpoint; caching can be disabled per project; request-response logging is
  off by default; Grounding with Google Search data is stored 3 days and Google Maps 30 days [V1, page updated 10 Nov
  2026 UTC]. Abuse monitoring: flagged prompts are stored "up to 90 days in the same region"; customers with a Cloud
  Master Agreement can get "ZDR-aligned abuse logging" with no human review, while customers on online terms get human
  review [V2].
- **India region.** Mumbai (`asia-south1`) supports `gemini-2.5-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`,
  `gemini-embedding-001` and Embeddings for Text. It does **not** list `gemini-2.5-flash-lite` (our default model) or
  `gemini-embedding-2` [V3, page updated 11 Nov 2026 UTC; read from the table's support marks].
- **DPA and sub-processors.** Cloud Data Processing Addendum, last modified 30 Oct 2026 [G7]; sub-processor list last
  modified 19 Oct 2026 [G8].
- **Certifications.** The Cloud DPA §7.4 commits Google to keep ISO 27001 certificates and annual SOC 2 / SOC 3 reports
  for the "Audited Services" [G7]. We didn't check whether each Vertex model is on the Audited Services list.
- **List prices** (per 1M tokens, standard tier as we read the first table) [V4]: Gemini 2.5 Flash-Lite $0.10 input /
  $0.40 output (audio $0.30); Gemini 2.5 Flash $0.30 / $2.50 (audio $1.00); Gemini 3.5 Flash-Lite global $0.30 / $2.50,
  non-global $0.33 / $2.75 ("response and reasoning" output). Gemini Embedding is priced "per 1,000 count" at $0.00015
  online and $0.00012 batch, region Global; the page doesn't say what a "count" is (characters, tokens or requests).

### 2.3 AssemblyAI

- **Training (important).** The Terms of Service (effective 1 Jul 2026) §4.3(b) license Customer Data "to train
  AssemblyAI's artificial intelligence and machine learning models", with an opt-out "to the extent applicable to
  Customer's pricing plan"; §4.6 lets AssemblyAI use and own De-Identified Data for any purpose [A2]. The Data Controls
  doc says opt-out is **paid plans only**: "Free users cannot opt out of the model improvement program, set a TTL, or sign
  a BAA". Opting out stops training on Customer Data and De-identified Data and stops benchmarking, for new requests only
  [A6]. Files are also excluded from training when a BAA is signed or the EU servers are used [A7, A8].
- **Retention (pre-recorded, async).** With no TTL and no BAA: uploaded audio deletion begins at 24 h (at most 48 h);
  final transcripts deletion begins at **30 days**. A TTL can be set (1 h minimum; presets 1/3/7/30 days) on paid plans;
  a BAA defaults to 72 h; a customer `DELETE` request deletes at once. Some metadata is kept for logging and billing [A6,
  A7]. The page offers zero data retention for streaming, Sync STT, dictation and TTS when opted out of training; for the
  async (pre-recorded) product we use, it describes TTL-based deletion instead [A7].
- **Diarization and voiceprints (input for counsel).** The Biometric Data Addendum (effective 26 May 2026) applies "to the
  extent that Customer opts into a Biometric Feature"; it says processing of "speaker embeddings, voiceprints" may be
  biometric under BIPA, Texas CUBI and Washington law; the customer must give notice, get written consent and instruct
  deletion, on behalf of itself and AssemblyAI as service provider, and indemnifies AssemblyAI [A3]. The Biometric
  Notice & Consent FAQ says diarization "only applies if you opt in", its speaker embeddings "may be deemed biometric
  data depending on the applicable privacy law", and they "are created on a recording-by-recording basis and are not
  retained after the transcription of the recording is provided to you" [A4]. Our worker opts in on every chunk by
  default (§1, S1).
- **Regions.** Default `api.assemblyai.com` processes in US AWS regions; `api.eu.assemblyai.com` keeps audio and
  transcripts in the EU (Frankfurt, Stockholm, Ireland), while account and usage data stay in the US and file names may
  reach CrowdStrike and Datadog [A8]. **No India region** is listed.
- **DPA and sub-processors.** DPA effective 22 Jan 2026, with EU SCCs and a 10-day notice before a new sub-processor
  [A5]. The Trust Center lists 18 sub-processors, including AWS (US and EU), CrowdStrike, Datadog, Stripe, Anthropic (LLM
  processing, US) and Google Workspace [A9].
- **Certifications.** SOC 2 Type 2 (security, availability, confidentiality); BAA available for HIPAA [A10, A6].
- **Code-switching.** Universal-3.5 Pro "natively handles code switching across 18 languages", including English↔Hindi,
  with `language_detection: true` or `language_codes` [A11]. Our worker sends `speech_model: 'universal'`; which current
  model that maps to isn't stated on the pages we read.
- **List prices** [A1]: Universal-3.5 Pro $0.21/h; Universal-2 $0.15/h; **Speaker Diarization add-on $0.02/h** on both;
  keyterms prompting $0.05/h (included on Universal-2).

### 2.4 Azure OpenAI (Microsoft Foundry "Models sold by Azure")

- **Training.** Prompts, completions, embeddings and training data "are NOT available to OpenAI", "are NOT used to train
  any generative AI foundation models without your permission or instruction", and are not used to improve Microsoft or
  third-party products without permission [Z1, last updated 5 Jun 2026].
- **Retention.** Abuse monitoring may route flagged content to human review by authorised Microsoft employees (in the
  EEA for EEA deployments). Customers who meet Limited Access criteria can apply for **modified abuse monitoring**, which
  removes storage and human review [Z2, last updated 19 May 2026]. The retention period for abuse data isn't stated on the pages we
  fetched (**not verified**).
- **Regions.** Deployment type sets where inference runs: Global may use any Azure region; Data Zone stays in the US, EU
  or APAC zone; Standard (regional) keeps prompts and responses in the chosen Azure geography. Data at rest stays in the
  resource's geography [Z3, last updated 12 Aug 2026]. Which models are offered as Standard (regional) in Central India or South India
  is **not verified** (the model page only shows South India for fine-tuning) [Z4].
- **DPA, sub-processors, certifications.** Governed by the Microsoft Products and Services DPA [Z1]. We didn't read the
  DPA text, the sub-processor list or the compliance offerings (**not verified**).
- **Stages offered.** S2, S3 (GPT models), S4 (`text-embedding-3-small`, 1,536 dims by default per OpenAI's model; not
  checked on Azure), and S1 via `gpt-4o-transcribe-diarize` (priced per token).
- **List prices** (USD per 1M tokens, page default region) [Z5]: GPT-4o-mini Global $0.15 / $0.60, Data Zone and Regional
  $0.165 / $0.66; GPT-4.1-mini Global $0.40 / $1.60, Regional $0.44 / $1.76; `text-embedding-3-small` $0.000022 per 1K
  tokens ($0.022 per 1M); `gpt-4o-transcribe-diarize` audio input $6 per 1M tokens.

### 2.5 OpenAI API

- **Training.** "As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless
  you explicitly opt in)" [O1]; the enterprise privacy page (updated 8 Jan 2026) says the same [O2].
- **Retention.** Abuse monitoring logs are kept up to 30 days by default for `/v1/chat/completions`, `/v1/responses` and
  `/v1/embeddings`; `/v1/audio/transcriptions` shows no abuse-monitoring or application-state retention. Zero Data
  Retention and Modified Abuse Monitoring need OpenAI's prior approval (contact sales) [O1].
- **Regions.** Data residency is a sales-approved project setting with a 10% uplift for models released on or after 5 Mar 2026. India is listed for regional storage; in Australia, India and Japan, "organizations with active Zero Data
  Retention can use gpt-6-luna for regional processing" [O1].
- **DPA and sub-processors.** DPA by request form [O2]. Sub-processor list (updated 14 Oct 2026) includes Microsoft
  (cloud infrastructure, India among locations), CoreWeave, Oracle, Google Cloud, AWS, Cerebras, and TaskUs and Accenture
  for content moderation and support [O3].
- **Certifications.** API Platform SOC 2 Type 2; BAA available [O2].
- **Stages offered.** S2, S3, S4 and S1 (`gpt-4o-transcribe-diarize`, listed as Deprecated) [O4].
- **List prices** (per 1M tokens) [O4, O5]: `gpt-6-luna` $0.10 / $0.50 (batch $0.05 / $0.25); `gpt-4o-mini` $0.15 /
  $0.60 (listed as Deprecated; this is the price in `bootstrap.ts` L72; _correction 2026-11-18: now L125_); `text-embedding-3-small` $0.02;
  `gpt-4o-transcribe-diarize` audio input $2.50; `gpt-4o-mini-transcribe` $1.25.

### 2.6 Sarvam

- **Training.** The Terms (v2.0, effective 29 Jul 2026) §17.5: "Where and to the extent we use Inputs, Outputs or usage
  data for training our machine-learning models, we will do so in accordance with the Privacy Policy and applicable law,
  and (where required) subject to your consent" [S2]. The Privacy Policy lists "Model training / service improvement:
  inputs and outputs, where applicable" with **consent** as the basis [S3]. The Trust Center says "we do not use one
  customer's data to train or fine-tune models for any other customer" [S4]. Whether API inputs are used to train
  Sarvam's shared models by default isn't clear from these three pages (open question).
- **Retention.** Retention "is configurable per customer and per data category", with an "ephemeral mode" that purges
  data after processing, and customers "can opt out of audio storage entirely" [S4]. The default for pay-as-you-go API
  accounts isn't stated.
- **Regions.** "In India, for Indian customers", on Azure Central India, with LLM inference on Yotta and NxtGen; VPC,
  on-prem and air-gapped options exist [S4]. The Terms add that Sarvam "may transfer it to other countries where we and
  our service providers operate" [S2].
- **DPA and sub-processors.** A standard DPA "covering Sarvam's role as a processor under DPDP" is available on request
  [S4]; no public sub-processor list was found.
- **Certifications.** ISO 27001:2022 and SOC 2 Type II; ISO 42001 and DPDP "in progress" [S4, S3].
- **Diarization and code-switching.** Saaras `saaras:v4` (default) and `v3`: 23 languages (22 Indian + English),
  `codemix` mode ("English words in English and Indic words in native script"), diarization through the Batch API, files
  up to 2 h [S5]. Sarvam's pages don't say whether diarization speaker data is kept.
- **List prices** [S1]: speech-to-text batch ₹0.49/min PAYG (₹0.45 Pro, ₹0.41 Growth, ₹0.38 Business); **batch with
  diarization ₹0.59/min** PAYG (₹0.54 / ₹0.50 / ₹0.47); Sarvam 105B LLM ₹15 input / ₹60 output per 1M tokens. Credits are
  non-refundable.
- **Stages offered.** S1 and (via its LLMs) S2/S3. No embeddings API on the pricing page.

## 3. Matrix (stage × criterion)

"—" means the provider doesn't offer that stage or we don't use it there. **NV** = not verified on a public page.

| Criterion                 | Gemini API (paid)                             | Vertex AI                                                  | AssemblyAI                                                         | Azure OpenAI                                   | OpenAI API                                              | Sarvam                                          |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Stages                    | S2, S3, S4                                    | S2, S3, S4                                                 | S1                                                                 | S1, S2, S3, S4                                 | S1, S2, S3, S4                                          | S1, S2, S3                                      |
| Trains on customer data   | No on paid; **yes on unpaid** [G1]            | No without permission [V1]                                 | **Yes by licence; opt-out on paid plans only** [A2, A6]            | No [Z1]                                        | No unless opted in [O1]                                 | Only with consent, scope unclear [S2, S3]       |
| Default retention         | Abuse logs "limited period", any country [G1] | Cache ≤24 h; flagged prompts ≤90 days in region [V1, V2]   | Audio 24–48 h; transcripts **30 days** [A7]                        | Abuse review; period NV [Z2]                   | 30 days abuse logs; transcription none [O1]             | Configurable; default NV [S4]                   |
| ZDR option                | No; "use Vertex AI" [G2]                      | Yes (cache off; CMA for ZDR abuse logging) [V1, V2]        | TTL ≥1 h; ZDR not for async [A6, A7]                               | Modified abuse monitoring by application [Z2]  | ZDR / MAM by approval [O1]                              | Ephemeral mode [S4]                             |
| DPA / sub-processors      | Processor terms [G9]; list [G8]               | Cloud DPA [G7]; list [G8]                                  | DPA [A5]; 18 listed [A9]                                           | MS DPA [Z1]; list NV                           | DPA on request [O2]; list [O3]                          | DPA on request [S4]; list NV                    |
| India / regions           | No regional option [G1, G4]                   | Mumbai, but not 2.5 Flash-Lite [V3]                        | US or EU only [A8]                                                 | Regional types; India model list NV [Z3]       | India storage; processing only gpt-6-luna with ZDR [O1] | India (Azure Central India) [S4]                |
| Diarization / voiceprints | —                                             | —                                                          | Opt-in feature; embeddings not retained; BDA duties on us [A3, A4] | `gpt-4o-transcribe-diarize`; retention NV [Z5] | `gpt-4o-transcribe-diarize` (Deprecated) [O4]           | Batch diarization; retention NV [S5]            |
| Hindi-English code-switch | —                                             | —                                                          | Universal-3.5 Pro, 18 languages incl. Hindi [A11]                  | NV                                             | NV                                                      | `codemix`, 22 Indian + English [S5]             |
| List price (main stage)   | Flash-Lite $0.10 / $0.40 per 1M [G5]          | 2.5 Flash $0.30 / $2.50; 3.5 Flash-Lite $0.33 / $2.75 [V4] | $0.21/h + $0.02/h diarization [A1]                                 | 4o-mini Regional $0.165 / $0.66 [Z5]           | gpt-6-luna $0.10 / $0.50 [O5]                           | ₹0.59/min with diarization; 105B ₹15 / ₹60 [S1] |
| Certifications            | Google DPA §7.4 (Audited Services) [G7]       | ISO 27001, SOC 2/3 (Audited Services) [G7]                 | SOC 2 Type 2; BAA [A10]                                            | NV                                             | SOC 2 Type 2; BAA [O2]                                  | ISO 27001, SOC 2 Type II [S4]                   |

## 4. Cost per meeting hour (**ESTIMATES**)

These are **our assumptions**, not measurements. `AiUsageCounter` can replace them after pilots.

Inputs:

- Speech rate ≈ 150 words/min → **9,000 words per meeting hour** (assumption).
- English ≈ 1.33 tokens/word → ≈ 12,000 tokens, plus prompt and JSON schema overhead → **T = 15,000 input tokens per
  pass** (assumption). Code-mixed Devanagari text usually tokenises heavier, so Hindi-heavy meetings may cost more.
- At ≈ 6 characters per word, one hour ≈ 54,000 characters, so the 200,000-char cap in `meeting-summary.ts` refuses
  meetings longer than about 3.7 hours (estimate).
- Passes: S2 summary (one pass, output **1,500** tokens assumed, cap 8,192) + S3 action items (one pass, output
  **1,000** assumed, cap 4,096). Repair retry assumed 0 typical; worst case one extra S3 pass.
- So **LLM input = 2 × T = 30,000 tokens; LLM output = 2,500 tokens** per meeting hour. Reasoning models bill reasoning
  as output, so their real output may be higher.
- S1: hours × (model rate + $0.02 diarization). Billing rounding per 600 s chunk is not checked.
- S4 (if enabled): ≈ 15,000 tokens (segments + summary) per hour, embedded once (content-hash skip).

Formula: `LLM $/h = 30,000 × input_price/1M + 2,500 × output_price/1M`; `STT $/h = model $/h + diarization $/h`.

| Stage    | Option                                     | Inputs used                    | **ESTIMATE per meeting hour** |
| -------- | ------------------------------------------ | ------------------------------ | ----------------------------- |
| S1       | AssemblyAI Universal-3.5 Pro + diarization | $0.21 + $0.02 [A1]             | **$0.230**                    |
| S1       | AssemblyAI Universal-2 + diarization       | $0.15 + $0.02 [A1]             | **$0.170**                    |
| S1       | Sarvam batch with diarization (PAYG)       | 60 × ₹0.59 [S1]                | **₹35.40**                    |
| S2+S3    | Gemini API 2.5 Flash-Lite (paid)           | $0.10 / $0.40 [G5]             | **$0.0040**                   |
| S2+S3    | Vertex 2.5 Flash (in Mumbai)               | $0.30 / $2.50 [V4]             | **$0.0153**                   |
| S2+S3    | Vertex 3.5 Flash-Lite (non-global, Mumbai) | $0.33 / $2.75 [V4]             | **$0.0168**                   |
| S2+S3    | Azure GPT-4o-mini Regional                 | $0.165 / $0.66 [Z5]            | **$0.0066**                   |
| S2+S3    | OpenAI gpt-6-luna                          | $0.10 / $0.50 [O5]             | **$0.0043**                   |
| S2+S3    | Sarvam 105B                                | ₹15 / ₹60 [S1]                 | **₹0.60**                     |
| S3 retry | Worst case, one extra S3 pass (Flash-Lite) | +15,000 in, +1,000 out         | **+$0.0019**                  |
| S4       | Gemini API `gemini-embedding-001`          | 15,000 × $0.15/1M [G5]         | **$0.0023**                   |
| S4       | OpenAI `text-embedding-3-small`            | 15,000 × $0.02/1M [O5]         | **$0.000300**                 |
| S4       | Azure `text-embedding-3-small`             | 15,000 × $0.022/1M [Z5]        | **$0.000330**                 |
| S4       | Vertex Gemini Embedding                    | "per 1,000 count" unit unclear | **not estimated**             |

Read-across (**ESTIMATE**): STT is more than 90% of AI cost per hour on every route in the table. With diarization, Universal-3.5 Pro is
$0.23/h, so a 20 h/month user is ≈ **$4.60** (`pricing-packaging.md` §3 now shows both figures, after `ab93ede`). Moving S2+S3 from Gemini API Flash-Lite to Vertex in Mumbai adds about $0.011–0.013 per hour.

## 5. Decisions for Akash (labelled OPTIONS, none decided)

### 5.1 Gemini tier for customer data

- **OPTION A: paid Gemini API.** Smallest change (same adapter, same host, same model). No training; but abuse logs are
  kept for a "limited period" and may be stored or cached in any country, there is no ZDR, and no India region [G1, G2].
- **OPTION B: Vertex AI in Mumbai.** No training, ZDR controls, regional endpoint, Cloud DPA [V1, G7]. Trade-offs: the
  default `gemini-2.5-flash-lite` isn't in Mumbai, so the model moves to 2.5 Flash or 3.5 Flash-Lite (≈ 4× LLM cost,
  still ≈ $0.015–0.017/h); needs a new adapter, auth and allowlist entry; ZDR-aligned abuse logging needs a Cloud Master
  Agreement [V2].
- **OPTION C: Vertex AI global endpoint.** Keeps 2.5 Flash-Lite pricing; no India residency, and the durable cache isn't
  region-bound [V1].
- Any option: stop routing customer data to the unpaid tier, as phase-7 notes already require.

### 5.2 PII redaction policy (no content redaction exists today)

- **OPTION A: none; rely on vendor terms.** Cheapest; depends on §5.1 and AssemblyAI opt-out.
- **OPTION B: redact before the LLM only.** Mask emails, phone numbers, Aadhaar/PAN-like patterns in our own code before
  S2/S3. Keeps STT accuracy; may hurt summaries and action-item owners.
- **OPTION C: vendor redaction at STT.** Not researched here (AssemblyAI PII redaction pricing and behaviour not checked).
- **OPTION D: per-org setting** that combines B with a stricter route for regulated orgs.

### 5.3 Embeddings provider (S4 is off today)

- **OPTION A: keep embeddings off** until §5.1 is decided. No cost, no new sub-processor.
- **OPTION B: `gemini-embedding-001` at 1,536 dims on Vertex Mumbai.** India region, same vendor as S2; caller must
  normalise vectors [G6, V3]; Vertex price unit unclear [V4].
- **OPTION C: OpenAI or Azure `text-embedding-3-small`.** Native 1,536 dims, ≈ $0.000300/h (OpenAI) or $0.000330/h (Azure); adds a vendor; Azure India
  regional availability NV; OpenAI India processing is limited to gpt-6-luna [O1].

### 5.4 AI budgets (`monthlyBudgetUsd`, ADR-009)

- **OPTION A: budget in STT hours** (per tier hours in `pricing-packaging.md` §4) and treat LLM as a small fixed margin.
- **OPTION B: USD per org per month** from the §4 estimates (for example 25 h × $0.25 ≈ $6.25 on Team), refusing jobs when
  spent, as ADR-009 already supports.
- **OPTION C: separate caps** for the Sarvam route (₹/min) and for embeddings backfills.

### 5.5 AssemblyAI training and retention (input for §5.1-style decision)

- **OPTION A:** paid plan + opt out in Data Controls + set a short TTL (e.g. 1 h) [A6]. Self-serve, no extra cost.
- **OPTION B:** use the EU endpoint for EU orgs (never used for training) [A7, A8].
- **OPTION C:** negotiate custom terms (de-identified data clause §4.6, biometric indemnity) [A2, A3].
- Any option: implementing provider `DELETE` after each chunk is needed to meet ADR-019 as written.
  _Correction 2026-11-18 (after #513, `1d7ba360`): implemented in 45e8664e; a retry sweep is still open._

## 6. Open questions

1. Does AssemblyAI treat `speaker_labels: true` as opting into a "Biometric Feature" under the BDA? (FAQ implies yes) [A3,
   A4].
2. Which model does `speech_model: 'universal'` select today, and is code switching on for it?
3. Which AssemblyAI plan is our account on? If free, training opt-out and TTL are unavailable [A6].
4. Vertex Gemini Embedding "per 1,000 count": characters, tokens or requests?
5. Azure: which GPT-4o-mini / 4.1-mini / embedding models are Standard (regional) in Central India or South India, and
   how long is abuse-monitoring data kept?
6. Sarvam: are pay-as-you-go API inputs used for training by default, what is the default retention, and is there a
   sub-processor list?
7. Real tokens per meeting hour for Hindi-English transcripts (replace the 15,000 assumption with `AiUsageCounter` data).
8. Counsel questions are appended to [legal-questions-brief.md](legal-questions-brief.md) §5 (items 9–13).

## 7. Outside docs/research (for the coordinator; not changed here)

- `apps/worker` / `packages/ai-core`: no provider delete call, so ADR-019's "deleted at the provider right after
  processing" isn't met. AssemblyAI supports `DELETE` on a transcript [A12].
  _Correction 2026-11-18 (after #513, `1d7ba360`): done for AssemblyAI in 45e8664e; the sweep, backfill and Gemini remain._
- `packages/ai-core/src/bootstrap.ts`: defaults labelled `tier: 'free'` for Gemini and AssemblyAI; OpenAI default price
  matches `gpt-4o-mini`, which OpenAI lists as Deprecated [O4].
  _Correction 2026-11-18 (after #513, `1d7ba360`): now L66/L81 free and L125 OpenAI paid, with a production guard (b8eb5ffb)._
- Default model `gemini-2.5-flash-lite` is not offered in Vertex Mumbai [V3].
- `docs/research/pricing-packaging.md` §3 leaves out the $0.02/h diarization add-on [A1]. **Applied** in `ab93ede`
  (§3 now has the add-on row and the $4.60 estimate).

## Sources

All fetched 2026-11-12 (IST). Dates in brackets are the page's own date where shown. For Microsoft Learn pages (Z1–Z4) the date is the
visible "Last updated on" badge, which Microsoft stores as a UTC timestamp (re-checked 2026-11-12 IST); it differs from
the `ms.date` metadata we first quoted.

| ID  | Source                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Gemini API Additional Terms of Service [effective 23 Mar 2026]: https://ai.google.dev/gemini-api/terms (canonical aistudio.google.com/docs/terms)                        |
| G2  | Gemini API zero data retention: https://ai.google.dev/gemini-api/docs/zdr                                                                                                |
| G3  | Gemini API logs policy: https://aistudio.google.com/docs/logs-policy                                                                                                     |
| G4  | Gemini API available regions: https://aistudio.google.com/docs/available-regions                                                                                         |
| G5  | Gemini API pricing: https://aistudio.google.com/docs/pricing                                                                                                             |
| G6  | Gemini API embeddings: https://aistudio.google.com/docs/embeddings                                                                                                       |
| G7  | Google Cloud Data Processing Addendum [last modified 30 Oct 2026]: https://cloud.google.com/terms/data-processing-addendum                                               |
| G8  | Google Cloud sub-processors [last modified 19 Oct 2026]: https://cloud.google.com/terms/subprocessors                                                                    |
| G9  | Google processor terms: https://business.safety.google/processorterms                                                                                                    |
| V1  | Zero data retention [updated 10 Nov 2026 UTC]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention                              |
| V2  | Abuse monitoring: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring                                                                 |
| V3  | Locations [updated 11 Nov 2026 UTC]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations                                                  |
| V4  | Vertex AI / Model Garden pricing: https://cloud.google.com/model-garden/pricing                                                                                          |
| A1  | AssemblyAI pricing: https://www.assemblyai.com/pricing                                                                                                                   |
| A2  | AssemblyAI Terms of Service [effective 1 Jul 2026]: https://www.assemblyai.com/legal/terms-of-service                                                                    |
| A3  | AssemblyAI Biometric Data Addendum [effective 26 May 2026]: https://www.assemblyai.com/legal/biometric-data-addendum                                                     |
| A4  | AssemblyAI Biometric Notice & Consent FAQs: https://www.assemblyai.com/legal/biometric-notice-and-consent-faqs                                                           |
| A5  | AssemblyAI Data Processing Addendum [effective 22 Jan 2026]: https://www.assemblyai.com/legal/data-processing-addendum                                                   |
| A6  | AssemblyAI Data Controls: https://www.assemblyai.com/docs/data-controls                                                                                                  |
| A7  | AssemblyAI Data retention and model training: https://www.assemblyai.com/docs/data-retention-and-model-training                                                          |
| A8  | AssemblyAI Cloud endpoints and data residency: https://www.assemblyai.com/docs/pre-recorded-audio/select-the-region                                                      |
| A9  | AssemblyAI Trust Center, sub-processors: https://www.assemblyai.com/legal/subprocessors (renders the Vanta trust center)                                                 |
| A10 | AssemblyAI Security: https://www.assemblyai.com/security                                                                                                                 |
| A11 | AssemblyAI Code switching: https://www.assemblyai.com/docs/pre-recorded-audio/code-switching                                                                             |
| A12 | AssemblyAI Delete transcripts: https://www.assemblyai.com/docs/pre-recorded-audio/delete-transcripts                                                                     |
| Z1  | Azure: Data, privacy and security for Models sold by Azure [last updated 2026-06-05]: https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy |
| Z2  | Azure: Abuse monitoring [last updated 2026-05-19]: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring                                      |
| Z3  | Azure: Deployment types [last updated 2026-08-12]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types                              |
| Z4  | Azure: Models [last updated 2026-10-29]: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models                                                       |
| Z5  | Azure OpenAI pricing (page default region, USD): https://azure.microsoft.com/en-us/pricing/details/azure-openai/                                                         |
| O1  | OpenAI: Your data: https://developers.openai.com/api/docs/guides/your-data                                                                                               |
| O2  | OpenAI: Enterprise privacy [updated 8 Jan 2026]: https://openai.com/enterprise-privacy/                                                                                  |
| O3  | OpenAI: Sub-processor list [updated 14 Oct 2026]: https://openai.com/policies/sub-processor-list/                                                                        |
| O4  | OpenAI model pages: https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize , …/gpt-4o-mini , …/gpt-4o-mini-transcribe                                   |
| O5  | OpenAI pricing and model pages: https://platform.openai.com/docs/pricing , https://developers.openai.com/api/docs/models/gpt-6-luna , …/text-embedding-3-small           |
| S1  | Sarvam API pricing: https://www.sarvam.ai/api-pricing                                                                                                                    |
| S2  | Sarvam Terms of Service [v2.0, effective 29 Jul 2026]: https://www.sarvam.ai/terms-of-service                                                                            |
| S3  | Sarvam Privacy Policy: https://www.sarvam.ai/privacy-policy                                                                                                              |
| S4  | Sarvam Trust Center: https://www.sarvam.ai/trust-center                                                                                                                  |
| S5  | Sarvam Saaras docs: https://docs.sarvam.ai/api/api-guides-tutorials/models/saaras                                                                                        |
