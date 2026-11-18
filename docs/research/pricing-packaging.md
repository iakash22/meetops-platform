# Pricing and packaging (benchmark and proposal, November 2026)

> **Update 2026-11-18:** a refreshed benchmark, a full cost-to-serve estimate and revised **proposals** (included hours,
> extra pack, free tier, gates) are in [pricing-packaging-v2.md](pricing-packaging-v2.md). This doc stays as the
> 2026-11-11 snapshot that other docs cite by section; v2 §1 lists every number that changed.

- Checked **2026-11-11 (IST)**. Competitor prices are list prices per user per month unless noted, before tax.
- **Localisation.** Our box fetches from India. Google Workspace, Microsoft 365 and Zoom served **INR** prices to it.
  Otter, Fireflies, Fathom, Read.ai, Krisp, Granola and Notta served **USD** to the same box (Otter's page says "Prices in
  USD"). We don't convert currencies: INR and USD are compared within their own currency.
- **Everything in §3 and §4 is a proposal**, not a decision. Prices need owner sign-off, a cost check at the FX rate of the
  day, and ADR-017 billing limits.

## 1. Benchmark: AI meeting assistants (USD or EUR, as published)

Sources are the vendor pages cited in PR #468 (fetched the same day), plus [verification-notes.md](verification-notes.md)
for Grain, Supernormal, Meetily and the Otter promotion.

| Vendor      | Free tier                       | Entry paid (annual / monthly)    | Team or business tier (annual / monthly) | Top tier              | Source |
| ----------- | ------------------------------- | -------------------------------- | ---------------------------------------- | --------------------- | ------ |
| Otter       | 300 min/mo, 30 min/meeting      | Pro $8.33 / $16.99 (promo shown) | Business $19.99 / $30 (promo shown)      | Enterprise custom     | [P1]   |
| Fireflies   | Yes                             | Pro $10 / $18                    | Business $19 / $29                       | Enterprise $39 annual | [P2]   |
| Fathom      | Unlimited recordings            | Premium $16 / $20                | Team $15 / $19 (2+); Business $25 / $34  | Enterprise $35 annual | [P3]   |
| tl;dv       | €0                              | Pro €18 / €29                    | Business €29 / €39                       | —                     | [P4]   |
| Read.ai     | 5 meetings/mo                   | Pro $15 / $19.75                 | Enterprise $22.50 / $29.75               | Enterprise+ $29.75    | [P5]   |
| Granola     | Basic $0 (30-day history)       | —                                | Business $14                             | Enterprise $35        | [P6]   |
| Avoma       | —                               | Startup $19 / $29 (recorder)     | Organization $29 / $39                   | Enterprise $39 annual | [P7]   |
| Grain       | $0                              | Pro $15 / $19 (one person)       | Business $29 / $39 (2+ seats)            | Enterprise custom     | [P8]   |
| Fellow      | 5 notes lifetime                | Team $7 / $11                    | Business $15 / $23                       | Enterprise $25 annual | [P9]   |
| Notta       | 120 min/mo                      | Pro $8.17 annual                 | Business $16.67 annual                   | Enterprise custom     | [P10]  |
| Supernormal | 15 credits/mo                   | Team $20/mo per 50 credits       | Business $40/mo per 50 credits           | —                     | [P11]  |
| Meetily     | Community edition (open source) | Pro $10 annual (off $25)         | —                                        | Enterprise custom     | [P12]  |

Patterns (from the table, our reading):

- Entry paid tiers run **$7–$16 annual** and **$11–$20 monthly**. Team and business tiers run **$15–$29 annual**.
- Monthly billing costs about 1.25–2× the annual rate (Fathom Premium 1.25×, Otter Pro about 2×).
- Several vendors charge only for people who record and give free viewer seats (Avoma, Grain, Bluedot per #468).
- Compliance features (SSO, HIPAA, custom retention) usually sit in Business or Enterprise tiers (see #468's table).
- Supernormal moved to shared credits with unlimited seats in April 2026 [P11].

## 2. Benchmark: India (INR, as published to an India visitor)

| Product                                      | Price (INR, per user/month, before GST)                     | Billing               | Includes AI meeting notes?                           | Source |
| -------------------------------------------- | ----------------------------------------------------------- | --------------------- | ---------------------------------------------------- | ------ |
| Google Workspace Business Starter            | ₹270                                                        | Monthly plan shown    | **No** Gemini in Meet (compare table, US page [P14]) | [P13]  |
| Google Workspace Business Standard           | ₹1,080 list (₹864 introductory, first 20 users, 12 months)  | Monthly plan shown    | Yes, "Gemini … in … Meet"                            | [P13]  |
| Zoom Workplace Pro                           | ₹1,240                                                      | Billed annually       | "My Notes: Unlimited", AI note taker                 | [P15]  |
| Zoom Workplace Business                      | ₹1,705                                                      | Billed annually       | Yes                                                  | [P15]  |
| ZoomMate add-on                              | ₹1,860                                                      | Billed monthly        | Yes (add-on)                                         | [P15]  |
| Microsoft 365 Copilot Business (add-on)      | ₹1,745 list ("now starting from ₹1,495.73"); ₹2,094 monthly | Paid yearly / monthly | Yes (needs an M365 plan)                             | [P16]  |
| Microsoft 365 Business Standard with Copilot | ₹1,955 paid yearly; ₹2,346 monthly                          | Paid yearly / monthly | Yes                                                  | [P16]  |
| Microsoft 365 Business Premium with Copilot  | ₹2,660 paid yearly; ₹3,192 monthly                          | Paid yearly / monthly | Yes                                                  | [P16]  |

- Zoom shows "excluding GST"; Microsoft says "GST extra as applicable"; Google says prices "do not include tax".
- **No AI-notetaker vendor in §1 showed INR** to our India box. That leaves room for INR-first pricing with UPI AutoPay,
  which ADR-017 already plans.

## 3. Our cost inputs (estimates)

| Input                                 | Published price                                                              | Source  |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| AssemblyAI Universal-3.5 Pro          | $0.21 per hour (18 languages, code switching)                                | [P17]   |
| AssemblyAI Universal-2                | $0.15 per hour (99 languages)                                                | [P17]   |
| AssemblyAI Speaker Diarization add-on | +$0.02 per hour on Universal-3.5 Pro and Universal-2                         | [P17]   |
| Sarvam speech to text                 | ₹0.49/min pay-as-you-go; ₹0.45 (Pro), ₹0.41 (Growth), ₹0.38 (Business) plans | [P18]   |
| Razorpay Subscriptions                | Per ADR-017: domestic 2%, +0.9% on card subscriptions, 18% GST on fees       | ADR-017 |

**Estimate (ours):** a user with 20 meeting hours a month costs about **$4.20** in STT on Universal-3.5 Pro without the
diarization add-on, or about **$4.60** with it ($0.21 + $0.02 = $0.23/h × 20 h) [P17]. Diarization is on by default in
our worker, so the add-on changes the relevant per-user estimate from $4.20 to $4.60. Sarvam pay-as-you-go is about
**₹588** (20 h × 60 min × ₹0.49). LLM cost for summaries and extraction is not included; we don't have a measured
per-meeting figure yet (`AiUsageCounter` in `packages/database/prisma/schema.prisma` can give one after pilots). Sarvam
is far costlier per hour than AssemblyAI at list price, so it should be an opt-in route for Indic-heavy orgs with a
minutes cap (see [specs/05](specs/05-mixed-language-indic-transcription.md)).

## 4. Proposed packaging (**proposal**)

Principles:

1. **Trust features in every tier, Free included:** consent receipts and revoke, the no-viral-growth guarantee, retention
   controls, audit of recordings. This is our differentiation (#468 proposals #3, #4, #15), so we don't gate it.
2. **Charge only people who record.** Viewers and approvers are free (matches Avoma, Grain).
3. **Minutes are the cost driver.** Each tier includes STT hours; extra hours are a pack.
4. **INR first, USD separately.** Prices are set per currency, not converted.
5. **Respect RBI e-mandate limits.** ADR-017 keeps each recurring charge at or under ₹15,000; larger amounts go by
   invoice or payment link.

| Tier (proposal)    | INR per recording user / month (annual / monthly) | USD per recording user / month (annual / monthly) | Included capture | Key features                                                                                                                                                             |
| ------------------ | ------------------------------------------------- | ------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Free               | ₹0                                                | $0                                                | 5 h/month        | Botless capture, summaries, evidence-linked action items, consent receipts, 1 integration (GitHub _or_ Jira) with approval                                               |
| Team               | **₹799 / ₹999**                                   | **$10 / $14**                                     | 25 h/month       | Commitment-graded items, "since last meeting" view, two-way GitHub + Jira sync, Hindi-English code-switching, admin rollout controls                                     |
| Business           | **₹1,499 / ₹1,799**                               | **$20 / $25**                                     | 50 h/month       | Team + SSO (ADR-021 defers SAML/OIDC to the first enterprise deal), pre-meeting digests, retention 7–365 days (ADR-019), audit export, Indic routing (Sarvam) with a cap |
| Enterprise         | Custom (invoice)                                  | Custom                                            | Custom           | DPA, biometric-free speaker mode, data residency (if built; #468 #14), private AI / BYOK (#468 #16), volume STT                                                          |
| Extra capture pack | ₹299 per 10 h (proposal)                          | $5 per 10 h (proposal)                            | —                | Any paid tier                                                                                                                                                            |

Why these numbers (our reasoning, not evidence):

- **Team ₹799 annual** sits below Workspace Standard (₹1,080), Zoom Pro (₹1,240) and the Copilot add-on (₹1,745) [P13, P15,
  P16]. Those bundles include a whole suite; we sell one job (meeting → tracked work), so we should be cheaper than any of
  them.
- **Team $10 annual / $14 monthly** matches Fireflies Pro annual ($10) and undercuts most entry monthly prices ($16.99–$20 for Otter, Fireflies and Fathom) [P1–P3].
- **Business $20 / $25** sits under Fathom Business ($25 / $34), Grain Business ($29 / $39) and Avoma Organization ($29 /
  $39) [P3, P7, P8].
- **Margin check (estimate):** Team includes 25 h; at Universal-3.5 Pro that is ~$5.25 STT per user if fully used. The $10
  annual price leaves room for LLM cost, but we must measure LLM cost before launch. Sarvam routing at ₹0.49/min would cost
  ~₹735 for 25 h, close to the ₹799 price, so Sarvam stays a capped Business feature unless a plan discount applies [P18].
- **E-mandate ceiling:** at ₹999 monthly, one charge covers up to 15 recording users under ₹15,000; at ₹1,799 monthly, up
  to 8. Larger monthly orgs move to annual invoice (ADR-017 item 3).

## 5. Open questions

1. Measured LLM cost per meeting hour (summaries, extraction, embeddings). Needed before prices are final.
2. Do we show prices with or without 18% GST on the INR page? Competitors show them without.
3. Seat-based (proposed) or Supernormal-style shared credits? Credits fit spiky usage but are harder to explain.
4. Should consent receipts for **participants** be free even for non-paying orgs? (Proposed: yes.)
5. USD billing path: ADR-017 suggests adding Paddle for overseas B2C or US sales tax; until then USD prices are list only.

## Sources (fetched 2026-11-11)

| ID  | URL                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | https://otter.ai/pricing (USD shown to an India visitor; promotional discounts shown)                                                                                                         |
| P2  | https://fireflies.ai/pricing                                                                                                                                                                  |
| P3  | https://www.fathom.ai/pricing                                                                                                                                                                 |
| P4  | https://tldv.io/pricing/                                                                                                                                                                      |
| P5  | https://www.read.ai/plans-pricing                                                                                                                                                             |
| P6  | https://www.granola.ai/pricing                                                                                                                                                                |
| P7  | https://www.avoma.com/pricing                                                                                                                                                                 |
| P8  | https://support.grain.com/en/articles/9253220-plans                                                                                                                                           |
| P9  | https://fellow.ai/pricing                                                                                                                                                                     |
| P10 | https://www.notta.ai/en/pricing                                                                                                                                                               |
| P11 | https://help.supernormal.com/en/articles/14418695-supernormal-2-0-plans-pricing                                                                                                               |
| P12 | https://meetily.ai/pro                                                                                                                                                                        |
| P13 | https://workspace.google.com/intl/en_in/pricing.html (INR)                                                                                                                                    |
| P14 | https://workspace.google.com/pricing (USD, fetched from a non-India server; compare table)                                                                                                    |
| P15 | https://zoom.us/pricing (INR rendered to an India visitor in a headless browser)                                                                                                              |
| P16 | https://www.microsoft.com/en-in/microsoft-365/business/compare-all-microsoft-365-business-products and https://www.microsoft.com/en-in/microsoft-365/copilot/business (INR, headless browser) |
| P17 | https://www.assemblyai.com/pricing                                                                                                                                                            |
| P18 | https://www.sarvam.ai/api-pricing                                                                                                                                                             |
