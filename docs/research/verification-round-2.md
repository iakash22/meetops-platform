# Verification round 2: platform reviews, Zoho INR prices, DPDP timeline, India market size

- **Checked:** 2026-11-12 (IST). Every fact below comes from a page or file fetched that day, listed in
  [Sources](#sources). Pages with a "last updated" date show it in the sources table.
- **Primary sources only.** These are vendor docs, the official Gazette, MeitY and Parliament. Anything secondary or
  paywalled is marked as such and is not used as proof.
- **Labels.** **Recommendation** means our proposal, not a decision. **Estimate** means a third-party projection or our
  own arithmetic. Neither is a fact.
- **Scope.** This is research only. No application code changed. Repo paths are at `integration/phase-1` `7568f206`.
  The branch was later brought up to date with `integration/phase-1` (which now includes #478) to clear a README
  conflict.

## Summary

| #   | Question                               | Answer                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Google Calendar scope class            | `calendar.events.readonly` is **sensitive** (Google gives "reading events stored in Google Calendar" as its example). No Calendar scope is **restricted**, so we need no CASA assessment. `calendarlist.readonly`: not restricted; whether it is sensitive is not stated publicly |
| 2   | GitHub Marketplace                     | GitHub Apps and OAuth apps can both list. Paid plans need publisher verification, an org owner, at least 100 installs (GitHub App), USD pricing, monthly and annual billing, and the Developer Agreement. GitHub keeps 5%                                                         |
| 3   | Atlassian Marketplace                  | Forge only for new apps (since 17 Sep 2025). Connect support ends 31 Jan 2027. Cloud Fortified ends 31 Dec 2026, replaced by Atlassian Enterprise Certified. Our 3LO Jira app can only get an informational listing                                                               |
| 4   | Zoho Meeting INR                       | Rendered in INR from India: Standard from **₹50**, Professional from **₹125** per host/month billed annually (10 participants). Recording is in Standard. Transcripts and keynotes are in Professional, and keynotes need the customer's own OpenAI key                           |
| 5   | DPDP: 18 months cut to 12?             | **No official instrument found.** G.S.R. 843(E) and Rule 1 still set 18 months. S.O. 5458(E), now read on egazette.gov.in, only fixes wording in s. 9(1) and s. 10(2)(c)(ii). The Lok Sabha replies of 12 Aug 2026 restate the 18 months                                          |
| 6   | India AI meeting-assistant market size | No primary source. Two paid syndicated reports disagree by about 3.4× for 2025. The GTM sizing stays an illustration                                                                                                                                                              |

## 1. Google Calendar OAuth scopes

### 1.1 What the code requests

| Where                                                            | Scopes                                                                                                                       | Notes                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/integrations/src/calendar.ts` L99–102 (requested L214) | `https://www.googleapis.com/auth/calendar.events.readonly`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | `access_type=offline`, `include_granted_scopes=false`. `assertReadOnlyCalendarScopes` (L152) rejects any grant that adds other scopes |
| `calendar.ts` L141–147 `GOOGLE_IDENTITY_SCOPES`                  | `openid`, `email`, `profile`, `userinfo.email`, `userinfo.profile`                                                           | Not requested. Allowed only if Google adds them to a grant                                                                            |
| `apps/api/src/modules/auth/application/google-oidc.ts` L17       | `openid email profile` (`GOOGLE_LOGIN_SCOPE`)                                                                                | Sign-in, separate flow                                                                                                                |

The calendar code makes two API calls:

- `GET calendars/primary/events` (L272). This is `events.list`.
- `GET users/me/calendarList/primary` (L333). This is `calendarList.get`, and the code reads only `id` and `summary`.

### 1.2 Classification

| Scope                                      | Class                                                  | Evidence                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.events.readonly`                 | **Sensitive**                                          | The sensitive-scope page says: "Examples of sensitive scopes include reading events stored in Google Calendar" [R2-G1]. The scope's meaning is "View events on all your calendars" [R2-G6]                             |
| `calendar.calendarlist.readonly`           | **Not restricted.** Sensitive or not: **not verified** | Not on Google's restricted list [R2-G2]. Google's scope list says sensitive scopes are "indicated in the Google Cloud Console" and doesn't mark them publicly [R2-G5]. Check the Data Access page of our Cloud project |
| `openid`, `email`, `profile`, `userinfo.*` | **Non-sensitive**                                      | Google pre-fills the Sign-In scopes under "Non-sensitive scopes" on the consent screen [R2-G1]                                                                                                                         |
| Any Calendar scope                         | **Not restricted**                                     | The restricted list covers Gmail, Drive (including `drive.meet.readonly`), Fit, Chat, Data Portability, Photos Ambient and Health. No Calendar scope is on it [R2-G2]                                                  |

### 1.3 What each class needs

| Class                   | What Google requires                                                                                                                                                                                                                                                                                                                                   | Time Google states                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Brand (all public apps) | Verify the logo, display name, URLs and domain ownership [R2-G3]. The branding status must be published before data-access verification [R2-G1]                                                                                                                                                                                                        | "2-3 Business days" [R2-G3, R2-G4]                                                |
| Sensitive               | A use-case justification, a demo video, and meeting the minimum-scope and Limited Use rules [R2-G1, R2-G3]. Unverified apps on sensitive or restricted scopes have a "100 new-user cap" [R2-G3]                                                                                                                                                        | "can take up to 10 days" [R2-G1]; FAQ says 10 business days [R2-G3]               |
| Restricted              | Everything above, plus an **annual** security assessment by a CASA-authorised assessor under the App Defense Alliance. It is based on OWASP ASVS, with assurance levels AL1 or AL2 set by user count, scopes and other signals. Passing earns a "Letter of Validation" [R2-G7]. Tier 3 assessors need read-only access to the production cloud [R2-G3] | "6 weeks", "not guaranteed" [R2-G3]; "can potentially take several weeks" [R2-G4] |

On cost, the FAQ says "Google does not charge the developer any fees for security assessment". The cost "is agreed on
between the developer and the assessor without any involvement from Google". Apps eligible for the free Tier 2 option
can scan themselves, or pay an assessor instead [R2-G3]. We found no published price, so we give none.

**For us:** we need brand verification and sensitive-scope verification. We do not need a CASA assessment while we stay
off restricted scopes. Until we are verified, sign-ups are capped at 100 new users.

### 1.4 Narrower scopes (**recommendation**)

1. **Events.** `events.list` also accepts `calendar.events.owned.readonly`, "See the events on Google calendars you own"
   [R2-G8, R2-G6]. We read only `primary`, so this narrower scope may be enough.
   - To check first: does it return the events other people invite the user to? Test in a dev project before switching.
   - Whether this scope is sensitive is not stated publicly either; the Console shows it.
2. **Calendar list.** We call `calendarList.get` only to read `id` and `summary`.
   - Option: identify the account from the sign-in `email` claim (non-sensitive) and drop `calendarlist.readonly`.
   - Option: use `calendar.calendars.readonly` with `calendars.get` [R2-G9]. That scope is not clearly narrower ("title,
     description, default time zone, and other properties of Google calendars you have access to" [R2-G6]).
   - Either option is a code change. `assertReadOnlyCalendarScopes` requires the exact set, and ADR or owner sign-off
     comes first.

## 2. GitHub Marketplace

| Topic                   | What docs.github.com says                                                                                                                                                                                                                                                                    | Source         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| GitHub App or OAuth app | Both can be listed. "GitHub Apps are the officially recommended way to integrate with GitHub because they offer much more granular permissions"                                                                                                                                              | [R2-H1]        |
| Who can sell            | "Anyone can share their apps … for free … but only apps owned by organizations can sell". Only organisation owners can create and submit listings                                                                                                                                            | [R2-H1, R2-H2] |
| Publisher verification  | Needed for paid plans. It checks that the org profile and contact email are complete, that 2FA is required for the org, and that the org has a domain showing the "Verified" badge. Then request verification                                                                                | [R2-H3, R2-H4] |
| All listings            | A valid privacy-policy link and support contact. "Publicly available … cannot be in public preview or available by invite only". Must integrate "beyond authentication". Must set up webhooks for plan changes and cancellations. Must accept the **GitHub Marketplace Developer Agreement** | [R2-H2]        |
| Paid plans              | "GitHub Apps should have a minimum of 100 installations" (OAuth apps 200 users). Handle Marketplace purchase events: new, upgrade, downgrade, cancel, free trial. "Must support both monthly and annual billing"                                                                             | [R2-H2]        |
| Pricing                 | Free, flat rate or per unit. "Prices are set, displayed, and processed in US dollars". Free trials are fixed at 14 days                                                                                                                                                                      | [R2-H5, R2-H6] |
| Review                  | Click "Request publish". "An onboarding expert will reach out". Paid listings also go through financial onboarding                                                                                                                                                                           | [R2-H7, R2-H1] |
| Payout                  | Paid monthly once revenue reaches US$500 for the month. GitHub keeps 5% of transactions after 1 Jan 2021. The page points to the Developer Agreement for current terms                                                                                                                       | [R2-H8]        |

**For us:** ADR-007 already uses a GitHub App, which is the recommended type.

- A free listing is possible once the app is public and not invite-only.
- A paid listing needs:
  - an organisation owner (not a personal account);
  - publisher verification;
  - at least 100 installs;
  - USD-only pricing, which doesn't match ADR-017's INR billing.
- **Recommendation:** a free listing that leads to MeetOps billing. Check first that the Developer Agreement allows this
  (we did not read the agreement).

## 3. Atlassian Forge and Marketplace

| Topic                 | What developer.atlassian.com says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Source           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Forge vs Connect      | Since 17 Sep 2025 only Forge apps can be submitted. Connect "will no longer be a supported platform from 31 January 2027" (moved from December 2026). After that, Atlassian fixes only critical security issues                                                                                                                                                                                                                                                                                                                              | [R2-A1, R2-A2]   |
| OAuth 2.0 (3LO) apps  | "can be listed on the Atlassian Marketplace, [but] they will appear as informational listings only, with limited Marketplace features". Unapproved integrations show users a "not yet been reviewed by Atlassian" warning; there is a separate approval process. An older page (Dec 2024) says 3LO apps "cannot be listed" — we follow the newer page (Nov 2026)                                                                                                                                                                             | [R2-A3, R2-A4]   |
| Security requirements | All cloud apps follow the Marketplace Partner Agreement. Requirements include: authenticate every endpoint; full-disk encryption for stored End User Data; TLS 1.2+ with HSTS of at least one year; least-privilege scopes; secure secret storage; no known critical or high vulnerabilities in dependencies; no end-of-life Node; no collecting Atlassian credentials; the Security Bug Fix Policy; incident reporting; a security contact. There are extra sections for Forge remotes (verify the Forge Invocation Token) and for 3LO apps | [R2-A5]          |
| Incident clock        | Partner Agreement: notify Atlassian of a Security Incident "promptly (within 48 hours)". Support: respond within 24 hours to critical requests and within five business days to others                                                                                                                                                                                                                                                                                                                                                       | [R2-A10]         |
| Cloud Fortified → AEC | Cloud Fortified closed to new submissions on 1 Sep 2026 and retires on 31 Dec 2026. Atlassian Enterprise Certified (AEC) launched on 1 Oct 2026 for Forge cloud apps. It goes "beyond the baseline security requirements", including an annual penetration test (Bugcrowd or CREST)                                                                                                                                                                                                                                                          | [R2-A6, R2-A7]   |
| Data residency        | Forge hosted storage (KVS, Custom Entities, Forge SQL, Object Store) follows the host site's location. Forge Remote can pin region-specific `baseUrl`s. Eligible apps show "PINNED". Forge apps with no egress and Atlassian-hosted compute and storage get the "Runs on Atlassian" badge                                                                                                                                                                                                                                                    | [R2-A8, R2-A6]   |
| Paid apps             | Payment models are Paid via Atlassian, Paid via Vendor and Free. Revenue share to the partner: **Forge 84% from 1 Apr 2026, 83% from 1 Oct 2026**; Connect 80%, then 75%. From 1 Jan 2026, partners get 100% of Forge revenue up to $1M lifetime. The page cites "Section 4.2" of the Partner Agreement. A "Forge app" has no Connect modules, uses OAuth and uses Forge UI                                                                                                                                                                  | [R2-A9]          |
| Listing               | Review "usually takes 5-10 business days … to start". Needs End User Terms and a DPA (Atlassian offers a standard one), a Privacy & Security tab and licensing configuration. Test paid apps in dev or staging, because production installs are billed. The Partner Agreement's list-price clause requires the Atlassian price to be no higher than on any "Similar Service"                                                                                                                                                                 | [R2-A11, R2-A10] |

**For us:** our Jira integration is OAuth 3LO (`packages/integrations/src/jira-oauth.ts`).

- It can get an informational listing and Atlassian's 3LO approval, with no revenue share.
- A paid, reviewed listing (or AEC) needs a Forge app. If it calls our API it would be a Forge Remote, which brings FIT
  checks and region pinning for residency.
- The price-parity clause would tie Marketplace prices to our direct INR prices. Ask counsel before listing a paid app.

## 4. Zoho Meeting prices in INR

The India URL `zoho.com/in/meeting/pricing.html` returns 404, and `zoho.in/meeting/pricing.html` redirects to the global
page. The global page fills prices in by script from Zoho's own price file (`meeting-pricing-val.json`, which has an INR
column among 23 currency columns) and picks the currency from the visitor's location [R2-Z1, R2-Z2]. A headless browser on
our India-based box rendered INR.

Meeting plans, **per host/month, billed annually**, before GST. The page says "Local taxes (VAT, GST, etc.) will be
charged in addition":

| Participants | Standard | Professional |
| ------------ | -------- | ------------ |
| 10           | ₹50      | ₹125         |
| 25           | ₹167     | ₹250         |
| 50           | ₹208     | ₹375         |
| 100          | ₹292     | ₹500         |
| 150          | ₹333     | ₹584         |
| 200          | ₹417     | ₹667         |
| 250          | ₹458     | ₹750         |

- **Free** is ₹0, with 100 participants and 60 minutes per meeting.
- The price file gives the **monthly** 10-participant prices as ₹60 (Standard) and ₹150 (Professional) [R2-Z2]. We
  didn't render the monthly toggle for the other sizes.
- **Recording:** "Meeting recording" and cloud recording storage of 5 GB per host start at **Standard**.
- **Transcripts and AI:** "Recording transcripts" and "Meeting keynotes" are **Professional** only.
- Keynotes come from the Zia integration. The customer pastes in their **own OpenAI API token**, organisation name and
  organisation ID. Zia transcription supports English, Spanish, French, German, Italian, Dutch and Russian [R2-Z3].
- Live transcription goes through a Rev AI integration, also with the customer's own token [R2-Z4].
- **Caveat:** the page picks the currency by location, so other visitors may see other prices. Re-render before quoting.

## 5. DPDP: is the 18-month transition being cut to 12?

**Answer: no official instrument shortening it has been found.** What the official sources say:

| Official source                                                                                                                                        | What it says                                                                                                                                                                                                                             | Source         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| G.S.R. 843(E), 13 Nov 2025 (commencement of the Act)                                                                                                   | Brings ss. 3–5, 6(1)–(8) and (10), 7–17, 27 (except 27(1)(d)), 28–34, 36, 37 and 44(2) into force "eighteen months from the date of publication"                                                                                         | [R2-D1]        |
| DPDP Rules 2025, Rule 1                                                                                                                                | Rules 1, 2 and 17–21 start on publication. Rule 4 starts after one year. Rules 3, 5–16, 22 and 23 start after eighteen months                                                                                                            | [R2-D2]        |
| Lok Sabha Unstarred Q 3943 and Q 3960, answered 12 Aug 2026                                                                                            | Both restate "an eighteen-month transition period". Phase 3 "(within eighteen months)" covers Data Fiduciary duties. Q 3960 adds that the Board posts were advertised in Employment News on 6 Jun 2026                                   | [R2-D3, R2-D4] |
| S.O. 5458(E), the DPDP (Removal of Difficulties) Order, 2026. Dated 5 Oct 2026, Gazette Extraordinary No. 5248 of 6 Oct 2026 (CG-DL-E-07102026-276885) | Now read on **egazette.gov.in**. It only substitutes words: s. 9(1) "child or of a person with disability", and s. 10(2)(c)(ii) "data audit". It does not touch commencement. The text matches the third-party copy we read before       | [R2-D5]        |
| MeitY DPDP Rules page                                                                                                                                  | When read earlier on 2026-11-12, it listed only the Rules (14 Nov 2025), the corrigendum (16 Dec 2025), the enforcement timeline, the Board's establishment and the members decision. A re-fetch later that day returned "Access Denied" | [R2-D6]        |

- The only source for a 12-month proposal is secondary reporting of a January 2026 stakeholder proposal (#478 [GT16]).
  It is not an official instrument.
- A web search for a PIB release or a Rajya Sabha answer that changes the timeline found none. We did not browse the
  PIB site itself, so this is "none found", not "none exists".
- **Dates (computed, not officially stated):**
  - Consent Manager rules start on 13 Nov 2026.
  - Data Fiduciary duties start on 13 May 2027.

## 6. India AI meeting-assistant market size

We found no primary source: no government statistic and no audited filing. These are the only India figures, both from
paywalled syndicated reports whose methods are not public:

| Publisher                  | Figure (**estimate**)                                                                                             | Source  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| Market Research Future     | India AI meeting assistants: $174.3M (2024), $219.04M (2025), $2,151.69M (2035), CAGR 25.67%. Updated 17 Sep 2026 | [R2-M1] |
| Ken Research (APAC report) | India: $65M (2025), CAGR 32% (2025–2032), inside an APAC total of $479M                                           | [R2-M2] |

The two figures for India in 2025 differ by about 3.4×. **Recommendation:** don't quote either as the market size. Keep
the GTM doc's SAM formula as an **illustration** with assumed inputs, and cite these two only as a range of third-party
estimates.

## 7. Corrections to earlier docs

#478 merged into `integration/phase-1` (merge `fe5d285c`, 2026-11-12 00:28 IST) while this PR was open, so
`gtm-india-smb-midmarket.md` is now a merged doc. Line numbers below are for that merged file.

**One merged doc is edited in this PR**, because it is a clear factual fix with primary sources:

| Edit | File and line                        | Was                                                     | Now                                                                                    | Basis                                                                                                                    |
| ---- | ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E1   | `gtm-india-smb-midmarket.md` L75     | "the standard Forge rate is 17% from 1 Jul 2026 [GT10]" | "the standard Forge rate is 16% from 1 Apr 2026 and 17% from 1 Oct 2026 [GT10, GT10b]" | Atlassian's 3 Nov 2025 post moved the dates [R2-A12]; the developer pricing page gives 84%, then 83% to partners [R2-A9] |
| E2   | `gtm-india-smb-midmarket.md` sources | —                                                       | New row GT10b citing R2-A12 and R2-A9                                                  | Supports E1                                                                                                              |

Not edited here. These are additions or better sources rather than errors, so they are left for the doc owner:

| File and line                         | Current text (short)                                                                | Suggested change                                                                                                                                          | Basis          |
| ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `gtm-india-smb-midmarket.md` L74      | Scope class "**not verified**"; GT8 is a search summary                             | `calendar.events.readonly` is sensitive and nothing we use is restricted, so no CASA. `calendarlist.readonly` not verified. Replace GT8 with R2-G1, R2-G2 | §1             |
| `gtm-india-smb-midmarket.md` L75, fit | "A listing needs a Forge app"                                                       | 3LO apps can get an informational listing; a paid listing needs Forge. Connect support ends 31 Jan 2027                                                   | [R2-A1, R2-A3] |
| `gtm-india-smb-midmarket.md` L78      | GitHub Marketplace "Not checked today"                                              | Add the §2 requirements: 100 installs, verified org publisher, USD, 5%                                                                                    | §2             |
| `gtm-india-smb-midmarket.md` L109     | S.O. 5458(E) read from a third-party copy                                           | Read on egazette.gov.in; the text is the same                                                                                                             | [R2-D5]        |
| `gtm-india-smb-midmarket.md` L149     | "Zoho Meeting's INR prices did not render"                                          | Add the §4 table (Standard from ₹50, Professional from ₹125, billed annually)                                                                             | [R2-Z1]        |
| `market-gaps.md` L87–88               | DPDP dates "recorded in our ADR-019 … We did not fetch the government source again" | Optional: cite G.S.R. 843(E) and Rule 1. The dates are right; only the citation improves                                                                  | [R2-D1, R2-D2] |
| `roadmap-plan.md` L78                 | Owner input "the Google Calendar client block"                                      | Optional addition: brand and sensitive-scope verification (about 2–3 plus 10 business days) before passing 100 new users                                  | §1.3           |
| `verification-notes.md` §3            | Still-unverified list                                                               | No change. None of its items are covered here                                                                                                             | —              |

## 8. Still unverified

- **Sensitive or not:** `calendar.calendarlist.readonly` and `calendar.events.owned.readonly`. Only the Cloud Console
  shows the class.
- **`calendar.events.owned.readonly` coverage:** whether it returns events other people invited the user to. Needs a test.
- **CASA prices:** not published. Not needed unless we add a restricted scope.
- **GitHub Marketplace Developer Agreement:** current fee and whether a free listing may send users to outside billing.
  We read the docs, not the agreement.
- **Atlassian:** the 3LO approval steps (not opened); the full AEC requirement list (only the first section read); and
  whether a Forge Remote app can keep the "Runs on Atlassian" badge (the badge requires no egress).
- **Zoho:** monthly INR prices beyond the 10-participant tier, and Webinar prices.
- **DPDP:**
  - PIB: found nothing by web search; the PIB site itself was not browsed.
  - The MeitY page refused a second fetch.
  - The 12-month proposal has no official source.
- **India market size:** no primary source exists.

## Sources

Fetched 2026-11-12 (IST). "Updated" dates are the page's own (UTC where Google says so).

| ID     | URL                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R2-G1  | https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification (updated 2026-11-10)           |
| R2-G2  | https://support.google.com/cloud/answer/13464325 (Restricted scopes)                                                                     |
| R2-G3  | https://support.google.com/cloud/answer/13463817 (Verification FAQ)                                                                      |
| R2-G4  | https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification (updated 2026-11-10)          |
| R2-G5  | https://developers.google.com/identity/protocols/oauth2/scopes (updated 2026-09-14 UTC)                                                  |
| R2-G6  | https://developers.google.com/workspace/calendar/api/auth (updated 2026-09-03 UTC)                                                       |
| R2-G7  | https://support.google.com/cloud/answer/13465431 (Security assessment)                                                                   |
| R2-G8  | https://developers.google.com/workspace/calendar/api/v3/reference/events/list (updated 2026-07-29 UTC)                                   |
| R2-G9  | https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get and .../calendarList/get (updated 2026-05-12 UTC)        |
| R2-H1  | https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/about-github-marketplace-for-apps                         |
| R2-H2  | https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app                  |
| R2-H3  | https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization |
| R2-H4  | https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/about-marketplace-badges                                  |
| R2-H5  | https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps      |
| R2-H6  | https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/setting-pricing-plans-for-your-listing           |
| R2-H7  | https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/submitting-your-listing-for-publication          |
| R2-H8  | https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/receiving-payment-for-app-purchases            |
| R2-A1  | https://developer.atlassian.com/platform/marketplace/listing-forge-successor-to-connect-apps/ (updated Nov 10, 2026)                     |
| R2-A2  | https://developer.atlassian.com/platform/adopting-forge-from-connect/connect-end-of-support-private-apps/                                |
| R2-A3  | https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/ (updated Nov 11, 2026)                                             |
| R2-A4  | https://developer.atlassian.com/developer-guide/cloud-development-options/ (updated Dec 12, 2024)                                        |
| R2-A5  | https://developer.atlassian.com/platform/marketplace/security-requirements/ (updated Feb 19, 2026)                                       |
| R2-A6  | https://developer.atlassian.com/platform/marketplace/changelog/ (entries of 26 Jun, 2 Sep and 1 Oct 2026)                                |
| R2-A7  | https://developer.atlassian.com/platform/marketplace/atlassian-enterprise-certified-program/ (updated Oct 28, 2026)                      |
| R2-A8  | https://developer.atlassian.com/platform/forge/data-residency/ (updated Sep 28, 2026)                                                    |
| R2-A9  | https://developer.atlassian.com/platform/marketplace/pricing-payment-and-billing/                                                        |
| R2-A10 | https://www.atlassian.com/licensing/marketplace/publisheragreement (Marketplace Partner Agreement)                                       |
| R2-A11 | https://developer.atlassian.com/platform/marketplace/listing-forge-apps/                                                                 |
| R2-A12 | https://www.atlassian.com/blog/development/extended-timelines-for-marketplace-revenue-share-changes (3 Nov 2025)                         |
| R2-Z1  | https://www.zoho.com/meeting/pricing.html (rendered in INR from India)                                                                   |
| R2-Z2  | https://www.zoho.com/sites/zweb/json/pricing/meeting-pricing-val.json (Zoho's price file used by that page)                              |
| R2-Z3  | https://help.zoho.com/portal/en/kb/meeting/user-guide/integrations/zia/articles/zia-ai                                                   |
| R2-Z4  | https://www.zoho.com/meeting/online-meeting-transcription.html                                                                           |
| R2-D1  | https://egazette.gov.in/WriteReadData/2025/267647.pdf (G.S.R. 843(E), Gazette text)                                                      |
| R2-D2  | https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf (DPDP Rules, 2025)                                  |
| R2-D3  | https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AU3943_458sox.pdf                                                           |
| R2-D4  | https://sansad.in/getFile/lsapps/loksabhaquestions/annex/188/AU3960_GyWSTk.pdf                                                           |
| R2-D5  | https://egazette.gov.in/WriteReadData/2026/276885.pdf (S.O. 5458(E); digitally signed 2026.10.07)                                        |
| R2-D6  | https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa                              |
| R2-M1  | https://www.marketresearchfuture.com/reports/india-ai-meeting-assistants-market-46198 (paywalled; summary only)                          |
| R2-M2  | https://www.kenresearch.com/industry-reports/asia-pacific-ai-meeting-assistant-market (paywalled; summary only)                          |
