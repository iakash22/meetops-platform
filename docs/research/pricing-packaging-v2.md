# Pricing and packaging v2: refreshed benchmark, cost to serve and decision brief (November 2026)

- Checked **2026-11-18 (IST)**. Competitor prices are list prices per user per month before tax unless noted. New source
  IDs are PV1–PV22 at the end. P… IDs point to [pricing-packaging.md](pricing-packaging.md) (#473), G…/V…/A… IDs to
  [ai-provider-due-diligence.md](ai-provider-due-diligence.md) (#489).
- **Labels.** Cost figures are **ESTIMATES** (ours), with inputs and formulas shown. Plans, prices, hours and gates are
  **PROPOSALS**. Choices for Akash are labelled **OPTION**. **UNVERIFIED** means we couldn't read it from a page or the
  code today. GST and RBI notes are our reading, **not tax or legal advice**; confirm with a CA.
- **Localisation.** Our box fetches from India. Pages that served INR are quoted in INR; USD comes from the same page in
  USD where it rendered, or from a fetch on a non-India server (marked). We don't convert competitor prices.
- FX for our own cost conversions only: **US$1 = ₹93.48** (ECB reference rate for 2026-11-17 via Frankfurter [PV19]).

## 0. Why a new doc, not an in-place revision

[pricing-packaging.md](pricing-packaging.md) is a dated snapshot (checked 2026-11-11) and other merged docs cite its
sections by number: [gtm-india-smb-midmarket.md](gtm-india-smb-midmarket.md) §5 ("from pricing-packaging.md §4"),
[ai-provider-due-diligence.md](ai-provider-due-diligence.md) §4 and §5.4, and
[design-partner-kit/icp-and-recruitment.md](design-partner-kit/icp-and-recruitment.md) §7. Rewriting it would silently
change what those references say. So this is a **new doc**; the old one gets a dated pointer at the top, and the GTM
brief's §5 gets a one-line pointer. Where v2 proposes a different number, §1 lists the old and new figures.

## 1. What changed since #473

| #   | Item                                                  | #473 (2026-11-11)                                                         | v2 (2026-11-18)                                                                                                                               | Why                                                        |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | AI notetakers showing INR to India                    | "No AI-notetaker vendor in §1 showed INR"                                 | **tl;dv now shows INR**: Pro ₹1,715, Business ₹2,499 per seat/month billed annually [PV4]                                                     | Live page today                                            |
| 2   | AssemblyAI top batch model                            | Universal-3.5 Pro, $0.21/h, 18 languages [P17]                            | **AssemblyAI-STT-3.7**, $0.21/h, 32 languages; Universal-3.5 Pro deprecated [PV12, PV13]                                                      | Price same, name and coverage changed                      |
| 3   | AssemblyAI free tier                                  | Not stated                                                                | "Up to 185 hours of pre-recorded transcription" [PV12]                                                                                        | New FAQ text                                               |
| 4   | Our cost per meeting-hour                             | STT only: $0.23/h with diarization; LLM "not included" (§3)               | **Full ESTIMATE $0.19–$0.47/h, base ≈ $0.297/h (≈ ₹27.7)**: STT + LLM + storage + egress + Postgres share (§3)                                | Brief asked for full COGS                                  |
| 5   | Team included hours (proposal)                        | 25 h per recording user                                                   | **15 h per recording user, pooled across the org** (proposal)                                                                                 | At 25 h fully used, Team INR annual margin ≈ 10% (§4.4)    |
| 6   | Business included hours (proposal)                    | 50 h per recording user                                                   | **30 h per recording user, pooled** (proposal)                                                                                                | At 50 h fully used, Business INR annual margin ≈ 4% (§4.4) |
| 7   | Extra capture pack (proposal)                         | ₹299 / $5 per 10 h                                                        | **₹499 / $8 per 10 h** (proposal)                                                                                                             | ₹299 is ≈ 4% margin at base COGS (₹277 per 10 h)           |
| 8   | Free tier capture (proposal)                          | 5 h/month (per recording user, as we read the table)                      | **5 h/month per org**, up to 3 recording users, 30-day retention (proposal)                                                                   | Caps the cost of free orgs at ≈ ₹139/month (§4.5)          |
| 9   | Admin rollout controls and retention gates (proposal) | Rollout in Team; retention 7–365 in Business, but principle 1 says "Free" | **Rollout and shortening retention in every tier; retention above 90 days in Business** (proposal)                                            | #473's table and principle 1 disagreed                     |
| 10  | E-mandate users per monthly charge                    | 15 Team / 8 Business under ₹15,000                                        | **12 Team / 7 Business** if the ₹15,000 cap applies to the GST-inclusive debit (our reading)                                                  | #473 didn't add 18% GST                                    |
| 11  | Headline prices                                       | Team ₹799 / ₹999, $10 / $14; Business ₹1,499 / ₹1,799, $20 / $25          | **Unchanged** (proposal)                                                                                                                      | Keeps the GTM headline "from ₹799"                         |
| 12  | Zoom Workplace INR                                    | Pro ₹1,240, Business ₹1,705                                               | Pro **₹1,239.25**, Business **₹1,704.25** per user/month billed annually [PV6]                                                                | Page now shows paise; same price within rounding           |
| 13  | Zoom AI add-on                                        | ZoomMate add-on ₹1,860 billed monthly [P15]                               | ZoomMate "from $20 /user/month", 2,200 AI credits/user/month [PV7]; **INR not rendered today (UNVERIFIED)**                                   | Credit-based now                                           |
| 14  | Google Workspace India plans                          | Starter ₹270; Standard ₹1,080 (₹864 intro)                                | Same, plus a new **Base ₹99** plan (50% off for 3 months from 1 Dec 2026), without Gemini in Meet; Business Plus not on the India page [PV11] | Live page today                                            |
| 15  | Read.ai Enterprise+                                   | $29.75                                                                    | $29.75 annual / **$39.75 monthly**, requires 5+ licences [PV5]                                                                                | Monthly price now shown                                    |
| 16  | Otter India promotion                                 | Promo prices shown                                                        | Pro **$8.49 monthly / $4.17 annual "\*Offer valid only with an India-issued credit card"**; Business $24 for 3 months (off $30) [PV1]         | New India-card promotion                                   |

Unchanged since #473 (re-checked today): Fireflies, Fathom, tl;dv EUR prices, Microsoft 365 Copilot INR prices, Gemini
2.5 Flash-Lite and `gemini-embedding-001` prices.

## 2. Competitor pricing and packaging (re-checked 2026-11-18 IST)

### 2.1 Prices

| Vendor                                  | Free tier                                                                                | Entry paid (annual / monthly)                                                                                                     | Team / business (annual / monthly)                                                                                                  | Top tier                                           | Metric                                                          | Source     |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| Otter                                   | 300 transcription min/mo, 30 min per conversation, 25 most recent conversations          | Pro $8.33 / $16.99 (India-card promo $4.17 / $8.49); 1,200 min/mo, 90 min/meeting                                                 | Business $19.99 / $30 (promo $24 for 3 months); unlimited meetings, 4 h/meeting                                                     | Enterprise custom                                  | Per user; minute caps on Free and Pro                           | [PV1]      |
| Fireflies                               | Unlimited transcription\*, limited AI summaries, 400 min storage per team, 20 AI credits | Pro $10 / $18 per seat                                                                                                            | Business $19 / $29 per seat                                                                                                         | Enterprise $39, annual only                        | Per seat; AI credits on top                                     | [PV2]      |
| Fathom                                  | Unlimited recordings and transcription; limited AI action items and Ask Fathom           | Premium $16 / $20                                                                                                                 | Team $15 / $19 (2-user minimum); Business $25 / $34                                                                                 | Enterprise $35, annual only                        | Per user                                                        | [PV3]      |
| tl;dv                                   | ₹0 / €0: unlimited recordings, AI notes for 10 meetings, retention "up to 3 months"      | Pro **₹1,715** annual (India render); €18 / €29                                                                                   | Business **₹2,499** annual (India render); €29 / €39                                                                                | Enterprise custom ("optional usage-based pricing") | Per seat                                                        | [PV4]      |
| Read.ai                                 | 5 meeting transcripts/mo, 1 h max meeting                                                | Pro $15 / $19.75                                                                                                                  | Enterprise $22.50 / $29.75                                                                                                          | Enterprise+ $29.75 / $39.75 (5+ licences)          | Per user; all licences in a workspace on one plan               | [PV5]      |
| Zoom Workplace (AI Companion in plan)   | Basic: summaries for 3 hosted meetings/mo, My Notes 3 uses/mo, 40 min meetings           | Pro **₹1,239.25**/mo billed annually; $14.16 annual / $16.99 monthly (USD from a non-India fetch)                                 | Business **₹1,704.25**/mo billed annually; $18.33 / $21.99                                                                          | Enterprise, contact sales                          | Per user; India page billed annually only                       | [PV6]      |
| ZoomMate (Zoom AI add-on)               | ZoomMate Basic with Workplace Basic (limits as above)                                    | "From $20 /user/month", 2,200 AI credits per user per month                                                                       | —                                                                                                                                   | —                                                  | Per user + credits                                              | [PV7]      |
| Microsoft 365 Copilot Business (add-on) | —                                                                                        | **₹1,745** list ("now starting from ₹1,495.73") paid yearly; ₹2,094 monthly. US: $21 list ("now from $18") yearly; $25.20 monthly | M365 Business Standard with Copilot ₹1,955 / ₹2,346 ($23.50 / $28.20); Business Premium with Copilot ₹2,660 / ₹3,192 ($32 / $38.40) | —                                                  | Per user; "usage-based billing for select advanced AI features" | [PV8, PV9] |
| Microsoft Teams Premium                 | —                                                                                        | **₹830** / $10 per user/month, paid yearly (Intelligent recap)                                                                    | —                                                                                                                                   | —                                                  | Per user add-on                                                 | [PV10]     |
| Google Workspace (Gemini in Meet)       | — (14-day trial)                                                                         | Base ₹99 and Starter ₹270: **no** Gemini in Meet                                                                                  | Standard **₹1,080** list (₹864 intro, first 20 users, 12 months): Gemini in Meet "summarise, translate and take notes"              | Enterprise, contact sales                          | Per user; "All plans billed monthly", annual toggle "save 16%"  | [PV11]     |

- GST: Microsoft "GST extra as applicable"; Zoom "excluding GST"; Google "does not include tax" [PV6, PV8, PV11].
- USD for Google Workspace is **UNVERIFIED** today: the box gets INR and the non-India fetch server got CAD.
- ZoomMate INR is **UNVERIFIED** today (the INR price didn't render; #473 read ₹1,860 billed monthly [P15]).
- Promotions seen today: Otter India-card offer, tl;dv "BLACKFRIDAY45" (45% off Business annual, "500 coupons only"),
  Microsoft "now starting from", Google Base and Standard intro prices [PV1, PV4, PV8, PV11].

### 2.2 What's gated per plan

| Vendor    | Integrations                                                                                      | CRM sync                                                                     | SSO / SCIM                                      | Retention                                                                | Admin and audit                                                      | API                                                       |
| --------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------- |
| Otter     | Zapier from Pro                                                                                   | Salesforce/HubSpot: 1 user (Pro), 5 users (Business), unlimited (Enterprise) | Enterprise; "minimum 100-user license required" | "Custom data retention" listed under admin; tier not parsed (UNVERIFIED) | Activity logs, usage analytics from Business                         | "Otter API & Webhooks": Enterprise                        |
| Fireflies | "All" integrations on every plan                                                                  | Included in integrations                                                     | Enterprise                                      | Custom retention: Enterprise                                             | Team analytics (Business); audit logs API, super admin (Enterprise)  | Every plan, rate-limited (Free 30/min, 500/day)           |
| Fathom    | Zapier/Make "limited use" on lower tiers; Slack, Claude, ChatGPT                                  | CRM sync max 3 users/domain on lower tiers; CRM field sync: Business         | Enterprise                                      | Custom retention: Enterprise                                             | Team security controls (Team)                                        | "Public API & MCP"; tier not parsed (UNVERIFIED)          |
| tl;dv     | 5,000+ via Zapier from Pro; team-wide (Business), org-wide (Enterprise)                           | CRM integrations and field mapping, Personal → Team → Org scope by tier      | Enterprise (custom SSO SAML/OIDC, SCIM)         | Free "up to 3 months"; custom from Pro                                   | Org admin role, activity log: Enterprise; consent settings per scope | "API, webhooks, and MCP server" from Pro (Personal scope) |
| Read.ai   | "Premium integrations (Notion, Salesforce, HubSpot, Jira, Confluence, Zapier, webhooks)" from Pro | Salesforce/HubSpot from Pro                                                  | Enterprise+ (SAML, SCIM)                        | Retention policy: Enterprise+                                            | Domain capture: Enterprise+                                          | Listed in navigation; tier not parsed (UNVERIFIED)        |
| Zoom      | Marketplace apps                                                                                  | —                                                                            | Business ("SSO, managed domains")               | Archival: Business                                                       | "Archival and data loss prevention APIs": Business                   | Platform APIs (not plan-gated on the pricing card)        |
| Microsoft | Microsoft 365 apps                                                                                | —                                                                            | Entra ID (in the M365 plan)                     | Purview (in the M365 plan)                                               | M365 admin                                                           | Graph (not priced on these pages)                         |
| Google    | Workspace apps                                                                                    | —                                                                            | Workspace identity                              | Vault from Business Plus (US/CAD page)                                   | Admin console                                                        | —                                                         |

Patterns (our reading, from the two tables):

- Entry paid tiers are **$8–$16 annual and $16–$20 monthly**; team/business tiers **$15–$25 annual**. Monthly costs about
  1.25–2× annual. Unchanged from #473.
- **SSO/SCIM and custom retention sit in the top tier at every specialist** (Otter needs 100 users). Our Business tier
  offering SSO (when built) and longer retention undercuts that.
- **Credits and usage are creeping in**: Fireflies AI credits, ZoomMate 2,200 credits, Microsoft "usage-based billing",
  tl;dv Enterprise "optional usage-based pricing". Pure flat seats are getting rarer at the AI layer.
- **India**: suites (Microsoft, Zoom, Google, Teams Premium) and now tl;dv price in INR; Otter targets India with a
  card promotion. The "INR-first" gap from #473 is narrower than it was a week ago.

## 3. Our cost to serve per meeting-hour (ESTIMATE)

### 3.1 What the code actually runs (integration/phase-1 at `17735409`; cited files unchanged since `d5ce7c97`)

| Stage                | Code                                                                                                                                                                                                                                                                                          | Cost driver                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Capture              | Browser and desktop record `audio/webm;codecs=opus` first (`apps/web/src/features/recording/recording-panel.tsx` L16, `apps/desktop/src/features/recording/recorder.ts` L14); no `audioBitsPerSecond` is set, so the browser default applies (bitrate **UNVERIFIED**; we assume 32–128 kbps). | Raw recording object (`kind: 'recording'`)                   |
| Normalise and chunk  | ffmpeg to 16 kHz mono `pcm_s16le` WAV (`packages/media-core/src/transcode.ts` L45–47); **both** `normalized.wav` and each 600 s chunk WAV are written to object storage (`apps/worker/src/media/processor.ts` L375–378 for `normalized.wav`, L415–418 for the chunk WAVs).                    | 115.2 MB per hour per WAV copy, two copies                   |
| STT                  | Worker reads chunk bytes (`apps/worker/src/ai/bootstrap.ts` L88) and uploads them to AssemblyAI `/v2/upload`; body sends `speaker_labels` and `speech_model: this.model`, default `'universal'` (`apps/worker/src/ai/providers/assemblyai.ts` L143, L185–190).                                | Per audio hour + diarization; upload egress from our compute |
| Summary + actions    | Gemini `gemini-2.5-flash-lite` by default (`packages/ai-core/src/env.ts` L18; also `packages/config/src/index.ts` L75); two passes, one bounded repair retry (#489 §1).                                                                                                                       | Tokens                                                       |
| Embeddings           | Off unless `SEMANTIC_EMBEDDINGS_ENABLED=true` (`apps/worker/src/embeddings/index.ts` L30–33).                                                                                                                                                                                                 | Tokens, if on                                                |
| Storage and Postgres | `STORAGE_PROVIDER` enum `minio`/`neon`/`r2`/`s3`, default `minio` (`packages/config/src/index.ts` L36); prod is R2 or S3 (`infra/docs/object-storage-prod.md`); hosting "is not chosen yet" (`docs/13-ops/README.md` L3).                                                                     | GB-months, requests, egress; one Postgres instance           |

Two code facts change the estimate:

- **Which AssemblyAI model runs is UNVERIFIED.** The adapter sends the legacy singular `speech_model: 'universal'`.
  AssemblyAI's current docs describe `speech_models` (plural), default `["assemblyai-stt-3-7"]` for accounts created on
  or after 17 Nov 2026, and an automatic move of `universal-3-5-pro` defaults to STT-3.7 from 8 Dec 2026 [PV13]. So we
  price STT at **$0.15–$0.21/h + $0.02 diarization**. Check the model on the AssemblyAI usage page or a test request.
- **We store about 0.24–0.29 GB per meeting-hour** (two WAV copies at 0.1152 GB each + 0.014–0.058 GB opus). ADR-019
  estimates "about 90 GB steady for 1,000 audio hours a month" at 90 days, which is 0.03 GB per hour
  (`docs/15-decisions/ADR-019-media-retention.md` L42). **Our reading of the code gives 8–10× that.** Deleting the WAV
  copies after a successful transcript would cut storage to the opus file only (an engineering change, not ours to make;
  see §8).

### 3.2 Inputs (official price pages, checked 2026-11-18 IST)

| Input                                     | Price                                                                                                                          | Source          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| AssemblyAI-STT-3.7 (batch)                | $0.21/h                                                                                                                        | [PV12]          |
| AssemblyAI Universal-2 (batch)            | $0.15/h                                                                                                                        | [PV12]          |
| AssemblyAI speaker diarization            | +$0.02/h (both models)                                                                                                         | [PV12]          |
| Gemini 2.5 Flash-Lite, paid tier          | $0.10 per 1M input (text), $0.40 per 1M output incl. thinking; free tier "Free of charge", "Used to improve our products: Yes" | [PV14]          |
| Gemini `gemini-embedding-001`, paid       | $0.15 per 1M input tokens                                                                                                      | [PV14]          |
| AWS S3 Standard, Mumbai (ap-south-1)      | $0.025 per GB-month (first 50 TB); PUT $0.005 per 1,000; GET $0.004 per 10,000                                                 | [PV16]          |
| AWS data transfer out to internet, Mumbai | $0.1093 per GB (first 10 TB/month beyond the free tier)                                                                        | [PV17]          |
| Cloudflare R2 Standard                    | $0.015 per GB-month; Class A $4.50 per million; Class B $0.36 per million; egress free; 10 GB-month free                       | [PV15]          |
| Amazon RDS for PostgreSQL, Mumbai         | db.t4g.medium Multi-AZ $0.167/h (≈ $122/month); Single-AZ $0.084/h; gp3 storage $0.131/GB-month                                | [PV18]          |
| Razorpay (payments)                       | ADR-017: domestic 2%, +0.9% on card subscriptions, 18% GST on fees; live page shows 2% standard                                | ADR-017, [PV22] |

### 3.3 Assumptions for one meeting-hour

- **Tokens** (kept from #489 §4 so the two docs agree): 150 words/min → 9,000 words → ≈ 12,000 tokens + prompt and
  schema → **15,000 input tokens per pass**; summary 1,500 output, actions 1,000 output → **30,000 in, 2,500 out**.
  Worst case adds one repair pass (+15,000 in, +1,000 out) and **×1.5 tokens for Hindi-heavy text** (assumption;
  Devanagari usually tokenises heavier).
- **Embeddings** (only when on): ≈ 15,000 tokens per meeting-hour (transcript segments + summary, embedded once), the
  same assumption as #489 §4 (S4); 15,000 × $0.15/1M = $0.00225 ≈ **$0.0023**.
- **Storage**: 0.2304 GB WAV + 0.0144–0.0576 GB opus (32–128 kbps, assumption), kept for the org's retention period.
- **Requests**: 10 s capture slices (`recorder.ts` L11) ≈ 360 session-chunk PUTs/h + ≈ 10 processed objects.
- **Egress**: the worker uploads 0.1152 GB of WAV per hour to AssemblyAI from our compute; priced at the AWS Mumbai
  internet rate (applies whichever bucket we pick, because it leaves our compute). Playback: one listen of the opus file.
- **Postgres**: one db.t4g.medium Multi-AZ instance (instance only; storage and backups excluded) spread over
  1,000 / 5,000 / 50,000 meeting-hours a month. Size and host are assumptions (hosting not chosen).
- **Excluded**: app compute, Redis, email, monitoring, backups and replication, support, Sarvam (off; lead decision
  2026-11-12), Deepgram (not used).

Formula: `COGS/h = STT + LLM + embeddings + storage (GB × $/GB-month × retention months) + requests + egress + Postgres/h`.

### 3.4 Result

| Line                           | Low                                           | **Base**                                                           | High                                                                 |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Scenario                       | Universal-2, R2, 7-day retention, 50,000 h/mo | STT-3.7, S3 Mumbai, 90-day retention (ADR-019 default), 5,000 h/mo | STT-3.7, Hindi-heavy + retry, embeddings on, S3 365 days, 1,000 h/mo |
| STT + diarization              | $0.170                                        | **$0.230**                                                         | $0.230                                                               |
| LLM (Flash-Lite, paid)         | $0.0040                                       | **$0.0040**                                                        | $0.0089                                                              |
| Embeddings                     | off                                           | **off**                                                            | $0.0023                                                              |
| Object storage                 | $0.0009                                       | **$0.0200**                                                        | $0.0864                                                              |
| Requests                       | $0.0017                                       | **$0.0018**                                                        | $0.0018                                                              |
| Egress (STT upload + playback) | $0.0126                                       | **$0.0165**                                                        | $0.0189                                                              |
| Postgres share                 | $0.0024                                       | **$0.0244**                                                        | $0.1219                                                              |
| **Total per meeting-hour**     | **≈ $0.19 (₹17.9)**                           | **≈ $0.297 (₹27.7)**                                               | **≈ $0.47 (₹43.9)**                                                  |

**COGS range (ESTIMATE): $0.19–$0.47 per meeting-hour; base ≈ $0.297 (≈ ₹27.7).** INR uses US$1 = ₹93.48 [PV19] on the unrounded base of $0.2967 (₹27.74). STT is about 78% of the base case.

### 3.5 Sensitivity (change from the base $0.297/h)

| Change                                                   | Effect per hour                       | Notes                                                                               |
| -------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Free Gemini tier instead of paid                         | −$0.004 (−1.3%)                       | Not allowed for customer data (#489 §5.1; phase-7 notes). No cost reason to use it. |
| Vertex in Mumbai (2.5 Flash or 3.5 Flash-Lite)           | +$0.011–0.013                         | From #489 §4                                                                        |
| Embeddings on (`gemini-embedding-001`, 15,000 tokens/h)  | +$0.0023                              | Off by default                                                                      |
| Universal-2 instead of STT-3.7                           | −$0.06                                | 99 languages but no native code switching claim [PV12]                              |
| Retention 7 / 30 / 90 / 365 days (S3)                    | $0.0016 / $0.0067 / $0.0200 / $0.0799 | R2: $0.0009 / $0.0040 / $0.0120 / $0.0480                                           |
| Delete both WAV copies after transcription (90 days, S3) | −$0.017                               | Storage falls to ≈ $0.0027 (opus only); engineering change                          |
| Backup replication (runbook: versioning + replica)       | up to +$0.020 at 90 days              | Doubles stored GB; transfer for cross-region replication not priced                 |
| Postgres at 1,000 vs 50,000 h/month                      | +$0.097 / −$0.022                     | Fixed cost; matters only at small scale                                             |
| FX ±5% (₹88.8–₹98.2 per $)                               | ±₹1.4 per hour                        | INR margins move with the rupee                                                     |

## 4. Plan proposals (PROPOSAL)

### 4.1 Pricing metric options

| OPTION                                                                    | How it bills                                                 | Pros                                                                                                                | Cons                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A. Hybrid (recommended): recording-user seats + pooled fair-use hours** | ₹/$ per recording user; org pool of hours; packs for overage | Familiar seat price (matches every competitor); viewers/approvers free (#473 principle 2); cost bounded by the pool | Needs a usage meter and a "pool nearly used" admin notice; ADR-009 `monthlyBudgetUsd` must map to hours |
| B. Pure seats, unlimited hours                                            | ₹/$ per recording user                                       | Simplest to explain                                                                                                 | Heavy users can cost > price (Team INR annual is negative at 25 h on the high COGS case)                |
| C. Pure usage (per meeting-hour)                                          | ₹/$ per hour processed                                       | Margin fixed per hour                                                                                               | Unpredictable bills; no competitor sells this way to SMBs; harder for e-mandates                        |
| D. Org credit pool (Supernormal-style)                                    | Credits shared by all users                                  | Fits spiky use                                                                                                      | Harder to explain; #473 open question 3                                                                 |

### 4.2 Proposed plans (v2)

| Plan       | INR per recording user / month (annual / monthly), excl. GST | USD (annual / monthly)    | Included capture (pooled per org)        | Key features (gates in §4.3)                                                                                                             |
| ---------- | ------------------------------------------------------------ | ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Free       | ₹0                                                           | $0                        | **5 h per org**, up to 3 recording users | Botless capture, summaries, evidence-linked action items, consent receipts, 1 integration (create-only, with approval), 30-day retention |
| Team       | **₹799 / ₹999** (unchanged)                                  | **$10 / $14** (unchanged) | **15 h** per recording user (was 25 h)   | Two-way GitHub + Jira sync, "since last meeting", commitment grading, Hindi-English code switching, org MFA enforcement                  |
| Business   | **₹1,499 / ₹1,799** (unchanged)                              | **$20 / $25** (unchanged) | **30 h** per recording user (was 50 h)   | Team + SSO when built (ADR-021), retention up to 365 days, audit export, API (when built), pre-meeting digests                           |
| Enterprise | Custom (invoice)                                             | Custom                    | Custom                                   | DPA, SCIM, residency if built, private AI/BYOK, Vertex Mumbai route, volume STT                                                          |
| Extra pack | **₹499 per 10 h** (was ₹299)                                 | **$8 per 10 h** (was $5)  | —                                        | Any paid plan; pool overage                                                                                                              |

### 4.3 Feature gating (PROPOSAL)

| Feature                                                                       | Free          | Team          | Business                    | Enterprise | Reason                                                                                                       |
| ----------------------------------------------------------------------------- | ------------- | ------------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Consent receipts and revoke (spec 03)                                         | ✓             | ✓             | ✓                           | ✓          | Trust feature, never gated (#473 principle 1)                                                                |
| No-viral guarantee and admin rollout/approval (spec 04)                       | ✓             | ✓             | ✓                           | ✓          | Spec 04 line 4 applies "when the org turns it on"; gating it would contradict principle 1 (change from #473) |
| Integration: create issues from approved items                                | 1 integration | GitHub + Jira | GitHub + Jira               | + custom   | Core job; Free shows the value                                                                               |
| Integration: **two-way sync** and "since last meeting"                        | —             | ✓             | ✓                           | ✓          | Main paid differentiator; adds webhook and API cost                                                          |
| MFA for every user                                                            | ✓             | ✓             | ✓                           | ✓          | Security baseline; don't gate                                                                                |
| **Org-wide MFA enforcement**                                                  | —             | ✓             | ✓                           | ✓          | Admin policy                                                                                                 |
| **SSO** (SAML/OIDC, ADR-021 defers to first enterprise deal)                  | —             | —             | ✓ when built                | ✓ + SCIM   | Competitors gate SSO at the top tier; Business undercuts                                                     |
| Retention: shorten (7–90 days)                                                | fixed 30 days | ✓             | ✓                           | ✓          | Deleting sooner is a privacy control; costs us less                                                          |
| Retention: **extend beyond 90 days (to 365)**                                 | —             | —             | ✓                           | ✓ custom   | Costs storage (≈ +$0.06/h at 365 days, S3)                                                                   |
| Audit: recording audit view                                                   | ✓             | ✓             | ✓                           | ✓          | #473 principle 1                                                                                             |
| **Audit export** and admin activity log                                       | —             | —             | ✓                           | ✓          | Buyer is security/IT (GTM §2)                                                                                |
| **API** (if built; not in the repo today as a public product API, UNVERIFIED) | —             | —             | read-only                   | full       | Competitors put APIs anywhere from every plan (Fireflies) to Enterprise (Otter)                              |
| Indic route (Sarvam)                                                          | —             | —             | — until Akash sets a budget | —          | Lead decision 2026-11-12                                                                                     |

### 4.4 Gross margin at each proposed price (ESTIMATE)

Margin = (price × (1 − 3.42% payment fee) − hours × COGS/h) ÷ price. 3.42% = 2.9% card-subscription fee + 18% GST on
the fee (ADR-017 figures; UPI would be lower). Excludes compute, Redis, support and the other exclusions in §3.3, so
this is a **contribution margin on AI, storage, egress and the Postgres share**, not company gross margin. "40% use"
assumes each recording user uses 40% of the included hours (**assumption**; replace with pilot data, metric M16 in
[pilot-success-metrics.md](design-partner-kit/pilot-success-metrics.md)).

| Plan (price, hours)                       | COGS at full use (base) | **Margin, full use, base** | Margin, full use, high COGS | Margin, 40% use, base |
| ----------------------------------------- | ----------------------- | -------------------------- | --------------------------- | --------------------- |
| v2 Team INR annual (₹799, 15 h)           | ₹416                    | **45%**                    | 14%                         | 76%                   |
| v2 Team INR monthly (₹999, 15 h)          | ₹416                    | **55%**                    | 31%                         | 80%                   |
| v2 Business INR annual (₹1,499, 30 h)     | ₹832                    | **41%**                    | 9%                          | 74%                   |
| v2 Business INR monthly (₹1,799, 30 h)    | ₹832                    | **50%**                    | 23%                         | 78%                   |
| v2 Team USD annual ($10, 15 h)            | $4.45                   | **52%**                    | 26%                         | 79%                   |
| v2 Team USD monthly ($14, 15 h)           | $4.45                   | **65%**                    | 46%                         | 84%                   |
| v2 Business USD annual ($20, 30 h)        | $8.90                   | **52%**                    | 26%                         | 79%                   |
| v2 Business USD monthly ($25, 30 h)       | $8.90                   | **61%**                    | 40%                         | 82%                   |
| v2 pack INR (₹499 per 10 h)               | ₹277                    | **41%**                    | 9%                          | —                     |
| v2 pack USD ($8 per 10 h)                 | $2.97                   | **59%**                    | 38%                         | —                     |
| _#473 Team INR annual (₹799, 25 h)_       | ₹693                    | _10%_                      | _−41%_                      | _62%_                 |
| _#473 Business INR annual (₹1,499, 50 h)_ | ₹1,387                  | _4%_                       | _−50%_                      | _60%_                 |
| _#473 Team USD annual ($10, 25 h)_        | $7.42                   | _22%_                      | _−21%_                      | _67%_                 |
| _#473 pack INR (₹299 per 10 h)_           | ₹277                    | _4%_                       | _−50%_                      | —                     |

Read-across (ESTIMATE): with #473's hours, an org whose users record most of their allowance loses money on annual INR
plans in the high case. Keeping #473's 25 h and 50 h at a 45% full-use margin would need about **₹1,344** (Team) and
**₹2,689** (Business) annual, above Workspace Standard (₹1,080) and the Copilot add-on (₹1,745), which breaks the
"cheaper than any suite" positioning. Cutting included hours keeps the headline prices.

### 4.5 Free tier and spec 04 (no viral growth)

- **Limits (proposal):** 5 h per org per month, up to 3 recording users, 30-day retention, one integration (create-only
  with approval), no two-way sync, no API. Cost cap per free org ≈ 5 × $0.297 ≈ **$1.48 (₹139)** a month at base,
  ₹220 at high COGS.
- **How it avoids viral-growth patterns** ([spec 04](specs/04-no-viral-growth-guarantee.md) §1): no bot joins on its
  own, so Free can't spread through calendars; no email or invite to attendees (receipt links are shared by the host,
  spec 03); no accounts or waitlists from attendee lists; admin approval toggle available on Free. Growth comes from
  in-org adoption, admins, marketplaces and partners (GTM §4), not from attendees.
- **Abuse controls:** one free org per verified domain (proposal); the per-org pool, not per-user, stops "add free
  users to get more hours". Spec 04 forbids using attendee data for sign-ups, so there's no referral loop to police.
- **Conversion triggers (proposal):** 4th recording user, pool exhausted, two-way sync, retention above 30 days.

### 4.6 India (INR, GST) and USD notes

- **GST**: IT and SaaS services are 18% GST (9% CGST + 9% SGST intra-state, 18% IGST inter-state); classification under
  SAC heading 9983 (e.g. 998313–998319) or 997331 for software licensing [PV20]. The 18% rate is from **secondary**
  sources citing Notification 11/2017 and 15/2025-CT(R) [PV21]; confirm with a CA. B2B buyers with a GSTIN can claim
  input tax credit, so exclusive pricing (like Microsoft, Zoom and Google) fits the ICP.
- **Prices shown exclusive of GST (proposal)**, with the inclusive figure at checkout: ₹799 → ₹942.82; ₹999 → ₹1,178.82;
  ₹1,499 → ₹1,768.82; ₹1,799 → ₹2,122.82; ₹499 pack → ₹588.82.
- **E-mandate ceiling**: ADR-017 keeps each recurring debit at or under ₹15,000. If that limit applies to the debited
  amount including GST (our reading, **UNVERIFIED** with RBI text today), one monthly charge covers **12 Team or 7
  Business** users, not 15 and 8 as #473 and the GTM brief say. Larger monthly orgs move to annual invoice.
- **USD**: list-only until a USD billing path exists (ADR-017 suggests Paddle for overseas). Exports of services can be
  zero-rated under an LUT (ADR-017 item: "LUT for zero-rated export invoices"); place-of-supply rules decide this per
  customer, so ask the CA.
- USD prices are set separately (#473 principle 4), not converted: $10 ≈ ₹935 at today's rate, above ₹799.

## 5. Design-partner pilot pricing

Today's docs: the pilot is "free, time-limited", "No fee during the pilot", 8 weeks, post-pilot discount is an OPTION
([pilot-agreement-outline.md](design-partner-kit/pilot-agreement-outline.md) §1, §3, §4); incentives proposal is free
use during the pilot and 3 months after, plus a first-year INR discount
([icp-and-recruitment.md](design-partner-kit/icp-and-recruitment.md) §7). Nothing may be linked to eval data (DPDP
s. 6(1), outline §4 and §14).

Our cost of a pilot (ESTIMATE): 10 recording users × 15 h × 2 monthly pools = **300 h ≈ ₹8,300 at base COGS (₹13,200 high)**. That basis assumes an 8-week pilot spans two monthly pools and both are fully used; pro rata over 8 weeks (56 days ÷ 30.4 days × 15 h × 10) is about 280 h ≈ ₹7,700;
at #473's 25 h, ≈ ₹13,900. Pilots also need the **paid** LLM tier before any customer data (outline §7; #489 §5.1).

| OPTION                               | What it is                                                                                                 | Pros                                                                          | Cons                                                                                         | Fit with current docs                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **P1. Free pilot** (current outline) | 8 weeks free, Team or Business features, hours capped at the v2 pool                                       | Easiest recruiting; matches outline §1 and §4 as written                      | No price signal; free users over-ask; ≈ ₹8,300 cost per 10-user pilot                        | As written                                                   |
| P2. Free pilot + post-pilot discount | P1, then e.g. 3 months free and 30–50% off the first annual INR invoice (size is Akash's call)             | Tests willingness to pay at conversion; matches icp §7                        | Discount anchors a lower price; 3 free months extend cost                                    | Matches outline §4 OPTION and icp §7                         |
| P3. Discounted paid pilot            | e.g. 50% of Team monthly (₹500 per recording user per month) during the pilot                              | Real price signal; buyer commits budget                                       | Slower recruiting; needs billing live (ADR-017) and a GST invoice; changes outline §1 and §4 | Needs outline §1/§4 edits                                    |
| P4. Paid pilot with credit back      | Flat fee (e.g. ₹10,000 for 8 weeks, proposal) credited in full to the first annual invoice if they convert | Strongest commitment signal; refundable in effect for converters; covers COGS | Hardest sell for SMBs; procurement for a pilot; changes outline §1 and §4                    | Needs outline §1/§4 edits and counsel on credit-back wording |

Recommendation (proposal): **P2** for the first 3–5 partners (recruiting matters most, and the outline already allows
it), with P4 offered to mid-market partners that ask for a formal paid pilot. Whatever is chosen: cap hours, keep it
independent of eval data, and record M16 (cost per meeting-hour) to replace the §3 estimate.

## 6. Decision points for Akash (labelled OPTIONS)

1. **Pricing metric.** A: hybrid seats + pooled fair-use hours (recommended). B: pure seats, unlimited. C: pure usage per
   hour. D: org credit pool.
2. **Included hours.** A: 15 h Team / 30 h Business, pooled (recommended). B: keep 25 h / 50 h and raise prices to about
   ₹1,344 / ₹2,689 annual. C: keep #473's hours and prices and accept ≈ 4–10% full-use margins on annual INR.
3. **Free tier.** A: 5 h per org, ≤ 3 recording users, 30-day retention (recommended). B: #473's 5 h per recording user.
   C: no free tier, 14-day trial only (Google and Microsoft style).
4. **Paid-LLM-tier gate.** A: paid Gemini API before any customer data, pilots included (recommended; costs ≈ $0.004/h).
   B: Vertex AI in Mumbai before GA (+$0.011–0.013/h, new adapter; #489 §5.1 B). C: free tier for internal dogfooding
   only, never for customer content.
5. **Launch currency.** A: INR-first, USD list only until a USD billing path exists (ADR-017; recommended). B: INR and
   USD billing at launch (needs Paddle or similar). C: USD-first.
6. **GST display.** A: exclusive, with the inclusive figure at checkout (recommended; matches the suites). B: inclusive.
7. **Pilot price.** P1 free; **P2 free + post-pilot discount (recommended)**; P3 discounted paid; P4 paid with credit
   back. Also set the discount size (outline §4).
8. **Extra pack.** A: ₹499 / $8 per 10 h (recommended). B: keep ₹299 / $5 (≈ 4% INR margin at base COGS).
9. **Retention gate.** A: shorten in every tier, extend beyond 90 days on Business (recommended). B: #473's table
   (all retention controls in Business).
10. **Storage follow-up for engineering.** A: ask the coordinator to delete WAV copies after a successful transcript
    and fix ADR-019's storage estimate (recommended). B: keep the copies (e.g. for re-transcription) and price
    retention accordingly.

## 7. Unverified items

- Which AssemblyAI model `speech_model: 'universal'` selects today (affects STT $0.15 vs $0.21 per hour).
- Capture bitrate (no `audioBitsPerSecond` set); we assumed 32–128 kbps.
- Hosting: S3 vs R2, compute host and its egress price, Postgres size and Multi-AZ storage (not chosen in the repo).
- Recorded hours per user per month: no data; margins at 40% use are an assumption.
- Google Workspace USD prices and annual INR prices; ZoomMate INR price; Otter's custom-retention tier; Fathom and
  Read.ai API tiers.
- GST rate read from secondary sources (classification from CBIC); whether the ₹15,000 e-mandate cap is GST-inclusive.
- Hindi token multiplier (×1.5) and the 15,000-token-per-pass assumption.
- Whether a public product API exists or is planned (it gates §4.3's API row).

## 8. Follow-ups outside docs/research (for the coordinator; not done here)

- `apps/worker/src/media/processor.ts` keeps both `normalized.wav` and the chunk WAVs; ADR-019 L42's storage estimate
  assumes ≈ 0.03 GB/h. Owner: media/worker and ADR-019.
- `apps/worker/src/ai/providers/assemblyai.ts` L188 sends the singular `speech_model`; AssemblyAI documents
  `speech_models` [PV13]. Owner: AI/worker.
- `packages/config/src/index.ts` L36 allows `STORAGE_PROVIDER=neon`, which the storage docs don't list
  (`docs/07-storage/storage-and-media.md` L58). Owner: config.
- `packages/ai-core/src/bootstrap.ts` L50 (Gemini) and L55 (AssemblyAI) label both default providers `tier: 'free'` (#489 §1); the paid-tier gate (decision 4)
  needs that changed before pilots.

## Sources (fetched 2026-11-18 IST unless noted)

| ID   | Source                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PV1  | https://otter.ai/pricing ("Prices in USD" to the India box; India-card offer)                                                                                                                             |
| PV2  | https://fireflies.ai/pricing                                                                                                                                                                              |
| PV3  | https://www.fathom.ai/pricing                                                                                                                                                                             |
| PV4  | https://tldv.io/app/pricing/ (INR, headless Chrome from the India box) and https://tldv.io/pricing/ (EUR offers in the page's schema.org data, non-India fetch)                                           |
| PV5  | https://www.read.ai/plans-pricing                                                                                                                                                                         |
| PV6  | https://zoom.us/pricing (INR, headless Chrome from the India box; USD from a non-India fetch)                                                                                                             |
| PV7  | https://www.zoom.com/en/products/ai-assistant/ ("Meet ZoomMate, your AI teammate")                                                                                                                        |
| PV8  | https://www.microsoft.com/en-in/microsoft-365/copilot/business (INR, headless Chrome)                                                                                                                     |
| PV9  | https://www.microsoft.com/en-us/microsoft-365/copilot/business (USD, headless Chrome)                                                                                                                     |
| PV10 | https://www.microsoft.com/en-in/microsoft-teams/premium and https://www.microsoft.com/en-us/microsoft-teams/premium (headless Chrome)                                                                     |
| PV11 | https://workspace.google.com/intl/en_in/pricing.html (INR)                                                                                                                                                |
| PV12 | https://www.assemblyai.com/pricing                                                                                                                                                                        |
| PV13 | https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model and https://www.assemblyai.com/docs/pre-recorded-audio/assemblyai-stt-3-7-migration-guide                                      |
| PV14 | https://ai.google.dev/gemini-api/docs/pricing (redirects to https://aistudio.google.com/docs/pricing; "Gemini Developer API pricing")                                                                     |
| PV15 | https://developers.cloudflare.com/r2/pricing/ (page "Last updated Oct 30, 2026")                                                                                                                          |
| PV16 | AWS Price List API, Amazon S3, ap-south-1: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-south-1/index.json (published 2026-11-18 08:41 IST)                                |
| PV17 | AWS Price List API, AWS Data Transfer, ap-south-1: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-south-1/index.json (published 2026-11-18 00:10 IST)                 |
| PV18 | AWS Price List API, Amazon RDS, ap-south-1: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-south-1/index.json (published 2026-11-18 04:25 IST)                              |
| PV19 | https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR,EUR (ECB reference rates; date 2026-11-17: INR 93.48)                                                                                          |
| PV20 | CBIC, Scheme of Classification of Services (annexure to Notification 11/2017-CT(R)): https://cbic-gst.gov.in/hindi/pdf/central-tax-rate/Notification11-CGST-Annexure.pdf                                  |
| PV21 | Secondary: https://msmetools.com/in/gst/gst-on-it-services and https://xoomai.com/gst-rate/software-services/ (18% under Notification 11/2017 and 15/2025-CT(R); search summaries, not the notifications) |
| PV22 | https://razorpay.com/pricing/                                                                                                                                                                             |
