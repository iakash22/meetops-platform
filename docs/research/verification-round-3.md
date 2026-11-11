# Verification round 3: DPDP G.S.R. numbers, the Rules corrigendum, CERT-In, vendor breach terms

- **Checked:** 2026-11-12 (IST). Every fact below comes from a page or file fetched that day, listed in
  [Sources](#sources). Where a page shows a "last updated" or effective date, the sources table gives it.
- **Primary sources.** The Gazette of India (egazette.gov.in), MeitY, CERT-In, RBI and each vendor's own legal pages.
  Anything secondary is marked **secondary** and is not used as proof.
- **Labels.** **Interpretation** means our reading of a source, not legal advice. Nothing here is a decision.
- **Scope.** Research only. No application code or ADR changed. Base: `integration/phase-1` at `80eb5c2b`.
  #492 (`dpdp-role-and-dpa-outline.md`) has since been merged (`40d5073c`); the nits in §2 are folded in this PR.

## Summary

| #   | Question                                  | Answer                                                                                                                                                                                                                    |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which G.S.R. is the DPDP Rules?           | **G.S.R. 846(E)** is the DPDP Rules, 2025. **G.S.R. 843(E)** is the notification bringing the Act's sections into force. Merged docs now say so (§1). No date changed                                                     |
| 2   | What does the Rules corrigendum change?   | G.S.R. 892(E) (dated 10 Dec 2025; Gazette No. 806 of 11 Dec 2025; MeitY listed 16 Dec 2025) fixes nine typos and one missing word. No period, duty or start date changes. #492's former "not read" bullet is updated (§2) |
| 3   | Have the CERT-In 2022 directions changed? | **No amendment found.** CERT-In lists only the 28 Apr 2022 directions, the May 2022 FAQs and a 27 Jun 2022 extension. 6 hours, 180 days and NTP sync stand as issued. The FAQs soften log location (§3)                   |
| 4   | Vendor breach notice and role             | AssemblyAI, Google and Resend: processor, notice "without undue delay", no fixed hours, no India-specific or DPDP terms. Razorpay: no DPA found; its terms put a 24-hour breach notice on **us** (§4)                     |
| 5   | New counsel questions                     | Four, added to [legal-questions-brief.md](legal-questions-brief.md) §5 as items 22–25 after #492 merged with items 14–21 (§5)                                                                                             |

## 1. G.S.R. 843(E) vs 846(E)

Both are in the Gazette of India Extraordinary, Part II, Section 3(i), and both were read on egazette.gov.in [V3-G1,
V3-G2]:

- **G.S.R. 843(E)** [V3-G1]: MeitY's notification under s. 1(2) of the Act appointing the dates on which the Act's
  provisions come into force. It is not the Rules. It is in Gazette issue No. 757, masthead dated 13 Nov 2025 (MeitY
  hosts a copy of the same e-Gazette ID CG-DL-E-14112025-267647).
- **G.S.R. 846(E)** [V3-G2]: the Digital Personal Data Protection Rules, 2025. The Gazette copy (No. 760, masthead dated
  13 Nov 2025) matches the PDF MeitY hosts [V3-G3]. Only 846(E) is in issue No. 760.

No merged doc labelled 843(E) as the Rules, but four lines cited "G.S.R. 843(E) and Rule 1" without naming the Rules'
own number. These lines now name 846(E) for the Rules and keep 843(E) for commencement. Dates were not changed: 13 Nov
2025 and the computed 13 May 2027 stay as they were. The 13 vs 14 Nov issue date stays an open counsel question (see
§2 and §5).

| File                         | Line | Before                                                       | After                                                                                                                       |
| ---------------------------- | ---- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `market-gaps.md`             | 88   | "(G.S.R. 843(E) and Rule 1 of the DPDP Rules 2025, read on…" | "(G.S.R. 843(E), the Act's commencement notification, and Rule 1 of the DPDP Rules 2025, G.S.R. 846(E), read on…"           |
| `verification-round-2.md`    | 21   | "G.S.R. 843(E) and Rule 1 still set 18 months."              | "G.S.R. 843(E) (the Act's commencement notification) and Rule 1 of the DPDP Rules (G.S.R. 846(E)) still set 18 months."     |
| `verification-round-2.md`    | 157  | "DPDP Rules 2025, Rule 1"                                    | "DPDP Rules 2025 (G.S.R. 846(E)), Rule 1"                                                                                   |
| `verification-round-2.md`    | 209  | "Cites G.S.R. 843(E) and Rule 1; dates unchanged"            | "Cites G.S.R. 843(E) (commencement) and Rule 1 of the Rules (G.S.R. 846(E)); dates unchanged"                               |
| `verification-round-2.md`    | 271  | R2-D2 "(DPDP Rules, 2025)"                                   | "(DPDP Rules, 2025, G.S.R. 846(E); Gazette copy: …/2025/267650.pdf)"                                                        |
| `gtm-india-smb-midmarket.md` | 104  | "corrigendum published 16 Dec 2025"                          | "corrigendum G.S.R. 892(E), dated 10 Dec 2025, in Gazette No. 806 of 11 Dec 2025, listed by MeitY as published 16 Dec 2025" |

Already correct, not changed: `verification-round-2.md` L156 and L270 (843(E) as commencement),
`gtm-india-smb-midmarket.md` L104 first cell, L227 and L228. No ADR was edited.

## 2. The DPDP Rules corrigendum (G.S.R. 892(E))

**Which document.** MeitY's DPDP Rules page lists "Corrigendum to Digital Personal Data Protection Rules 2025",
published 16.12.2025 [V3-G4]. That PDF is byte-identical to Gazette copy G.S.R. 892(E) [V3-G5]:

- Notification text dated 10 Dec 2025 ("New Delhi, the 10th December, 2025"), F. No. AA-11038/8/2025-CL&ES.
- Gazette No. 806, masthead "THURSDAY, DECEMBER 11, 2025", ID CG-DL-E-12122025-268455, digitally signed 12 Dec 2025.
- So the instrument is dated 10 Dec, the Gazette issue is 11 Dec, and "16 Dec 2025" is MeitY's listing date.

**What it changes** (page and line numbers refer to the Rules' Gazette copy, G.S.R. 846(E)):

| Item    | Where           | Rule                  | Correction                                                                  |
| ------- | --------------- | --------------------- | --------------------------------------------------------------------------- |
| (i)(a)  | p. 24, l. 22    | Rule 1(3)             | "of this Gazette" → "in the Official Gazette"                               |
| (i)(b)  | p. 24, l. 24    | Rule 1(4)             | "of this Gazette" → "in the Official Gazette"                               |
| (ii)    | p. 29, l. 44    | Rule 13(5)            | "Department" → "Departments"                                                |
| (iii)   | p. 32, l. 4     | Rule 23(1)            | "given in such" → "given in such order"                                     |
| (iv)(a) | p. 34, l. 1     | First Schedule        | "everybody" → "every body"                                                  |
| (iv)(b) | p. 34, l. 26    | First Schedule        | "(18 or 2013)" → "(18 of 2013)"                                             |
| (v)(a)  | p. 38, l. 2     | Fourth Schedule, Note | "." → ";"                                                                   |
| (v)(b)  | p. 38, ll. 1–15 | Fourth Schedule, Note | clause letters "(a) to (f)" → "(a) to (g)" (the printed Note repeats "(a)") |

The rule mapping is ours, checked against the page markers in the Rules PDF. A secondary site gives the same mapping
[V3-S1].

**Effect on our docs (interpretation).**

- No period, obligation or start date changes. The 12- and 18-month periods in Rule 1 are untouched. Items (i)(a) and
  (i)(b) only make explicit that they run from "publication in the Official Gazette".
- No merged doc quotes Rule 1's "of this Gazette", Rule 13(5), Rule 23, the First Schedule wording or the Fourth Schedule
  Note letters, so nothing needs correcting beyond the date note in §1.
- The corrigendum shows the same one-day gap as the Rules: the masthead says 11 Dec but the ID and signature say 12 Dec,
  just as the Rules' masthead says 13 Nov and their ID and signature say 14 Nov [V3-G2]. That supports keeping the
  issue date open for counsel. It doesn't settle it.

**What this PR now does in the merged #492 doc.** `dpdp-role-and-dpa-outline.md` does not quote any corrected text, so
its substance stands. Its §11 bullet now says the corrigendum (G.S.R. 892(E), dated 10 Dec 2025, Gazette No. 806 of
11 Dec 2025) has been read in this round and has no substantive effect. Optional: the corrigendum confirms the periods
run from publication "in the Official Gazette".

## 3. CERT-In directions under s. 70B(6)

**Status.** CERT-In's directions page ("Last Updated On November 12, 2026") lists three documents and nothing later
[V3-C1]:

1. Directions No. 20(3)/2022-CERT-In, 28 Apr 2022 [V3-C2]. Effective 60 days after issue.
2. FAQs, May 2022 [V3-C3]. The FAQs say they are "not a legal document" and do not replace, amend or alter the IT Act or
   the CERT-In Rules, 2013.
3. Extension, 27 Jun 2022 [V3-C4]. MSMEs (as defined in S.O. 1702(E), 1 Jun 2020) got until **25 Sep 2022**. The
   "validated names" and "validated address and contact numbers" duties for data centres, VPS, cloud and VPN providers
   (para (v) a. and f.) also became effective on 25 Sep 2022.

No amending direction was found on cert-in.org.in. No later Gazette notification or MeitY instrument amending the
directions came up in our egazette and web searches, but **we did not run a full Gazette search**, so this is "none
found", not "none exists".

**Related, not an amendment.** CERT-In's AI Security Auditing Guidelines v1.0 (4 Nov 2026), prepared by a CERT-In
working sub-group [V3-C5], restate the existing rules for AI systems: AI incidents "meeting CERT-In reportable criteria
shall be reported within 6 hours", plus "180-day log retention". They do not cite s. 70B(6) as their source of power
and do not change the 2022 text.

**The three requirements as they stand** [V3-C2, V3-C3]:

| Requirement     | 2022 directions                                                                                                                                                                             | FAQ gloss (not legally binding)                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incident report | (ii) Report Annexure I incidents "within 6 hours of noticing such incidents or being brought to notice about such incidents": incident@cert-in.org.in, phone 1800-11-4949, fax 1800-11-6969 | Q24: the 6 hours run from noticing. Q30: report what is known within 6 hours; send the rest "later within reasonable time"                               |
| Log retention   | (iv) Logs of all ICT systems kept securely for a rolling **180 days**, "within the Indian jurisdiction", given to CERT-In with a report or on order                                         | Q35: "The logs may be stored outside India also as long as the obligation to produce logs to CERT-In is adhered to by the entities in a reasonable time" |
| Clock sync      | (i) Connect to NIC or NPL NTP servers, or servers traceable to them. Entities spanning multiple geographies may use another accurate standard source that does not deviate from NPL and NIC | Q40: other sources are fine if they conform to NPL/NIC. Clocks need not be set to IST. Record the time zone with the time                                |

**Interpretation.** The FAQ on log location (Q35) contradicts the text of direction (iv) and says itself that it is not
legal. Until counsel says otherwise, assume the stricter text: 180 days of logs, held in India. This is counsel question 22.

**Not verified.** A secondary guide says the Jan Vishwas (Amendment of Provisions) Act, 2023 raised the s. 70B(7)
penalty from ₹1 lakh to ₹1 crore from 30 Nov 2023 [V3-S2]. We did not read the Act or its commencement notification.

## 4. Vendor breach notice and DPDP role

What each vendor's own DPA or terms say. None of the documents mentions the DPDP Act or India except Razorpay's.

| Vendor                                      | Role in its own terms                                                                                                                                                                                                                                | Breach notice to us                                                                                                                                                                                                                 | India / DPDP terms                                                                                                                                                                                       | Source         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| AssemblyAI (DPA, eff. 22 Jan 2026)          | §2.1: customer is Controller and AssemblyAI a Processor (sub-processor if the customer is a processor). §13: independent controller for Account Data and Usage Data                                                                                  | §8.1: "without undue delay", plus remediation at its discretion. §8.2: reasonable help with notifying authorities and data subjects. §8.3: no duty if the breach comes from the customer. No fixed hours                            | None. "Privacy Laws" means "any applicable laws … in any relevant jurisdiction", listing GDPR, Swiss, UK and US state laws. DPDP is not named                                                            | [V3-V1]        |
| Google Cloud DPA (covers Vertex AI)         | §4.1: "Google is a processor and Customer is a controller or processor". It covers Google Cloud Platform services as listed on the services page, which now names Vertex AI "Gemini Enterprise Agent Platform (formerly Vertex AI Platform)" [V3-V9] | §7.2.1: "promptly and without undue delay after becoming aware of a Data Incident". §7.2.2: nature, resources affected, Google's measures, recommended customer measures, contact point; partial notice first if needed             | None. "Applicable Privacy Law" covers "any national, federal … privacy, data security, or data protection law", so DPDP would fall under it (**interpretation**). India is not named                     | [V3-V2, V3-V9] |
| Gemini API (paid)                           | Gemini API terms: paid-tier prompts and responses are processed under Google's processor DPA. Unpaid tier: Google uses content to improve its products (no processor role)                                                                           | Processor DPA §7.2.1: "promptly and without undue delay"; same contents as the Cloud DPA. §7.2.3: sent to the Notification Email Address                                                                                            | None named. Same broad "Applicable Data Protection Legislation" definition. The Gemini API terms allow paid-tier data to be stored or cached "in any country" Google has facilities                      | [V3-V3, V3-V4] |
| Resend (DPA, last update 31 Dec 2025)       | §2.1: customer is controller or processor, Resend (Plus Five Five, Inc.) "is a processor"                                                                                                                                                            | §8.6: "without undue delay", plus remediation at its discretion. §8.7: reasonable help with GDPR notices. No fixed hours                                                                                                            | None. "Data Subject" is limited to people in the EEA or CCPA consumers. §6.1: "primary processing operations take place in the United States"                                                            | [V3-V5]        |
| Razorpay (Terms; Privacy, eff. 23 Feb 2026) | No DPA found (razorpay.com/dpa/ returned 404). Terms Part A §12.1–12.2: we consent to Razorpay processing personal data under its Privacy Policy, and we are "solely and absolutely responsible" for our customers' data                             | **Reverse direction.** Part A §12.3: **we** must notify Razorpay "in no event later than twenty-four (24) hours" after becoming aware of an actual or suspected breach of customer data. No clause found where Razorpay notifies us | Privacy Policy gives users rights "in accordance with the Digital Personal Data Protection Act, 2023" and names a DPO. Razorpay Payments Pvt Ltd is an RBI-authorised payment aggregator from 1 Jan 2026 | [V3-V6, V3-V7] |

**Razorpay and RBI data localisation.**

- RBI's PA Master Direction (RBI/DPSS/2025-26/141, 15 Sep 2025, "Updated as on November 11, 2026") para 9(c): a PA
  "shall comply with data storage requirements as applicable to Payment System Operators" under the 6 Apr 2018 circular.
  Annex 1 adds "Data Sovereignty" controls and says PAs report security incidents and cardholder data breaches to RBI
  [V3-R1].
- RBI circular DPSS.CO.OD No.2785/06.08.005/2017-2018 (6 Apr 2018): "the entire data relating to payment systems
  operated by them are stored in a system only in India", with full end-to-end transaction details. The foreign leg may
  also be stored abroad [V3-R2].
- RBI FAQs (26 Jun 2019): processing abroad is allowed, but the data must be deleted abroad and brought back "not later
  than the one business day or 24 hours from payment processing, whichever is earlier" [V3-R3].
- Razorpay's own blog (6 Apr 2026) restates the same rule for merchants [V3-V8]. It is not a contractual term.

**Interpretation.** AssemblyAI, Google and Resend describe themselves as processors, which fits sub-processors under
MeetOps' processor role (as #492 proposes). Their "without undue delay" has no hour limit, while DPDP Rule 7(2)(b) gives
the Data Fiduciary 72 hours to send the Board details [V3-G2] and CERT-In gives 6 hours [V3-C2]. Razorpay reads more
like an independent Data Fiduciary for the payment data RBI makes it hold than a processor of ours. Both are counsel
questions 23 and 24.

## 5. New counsel questions

Added to [legal-questions-brief.md](legal-questions-brief.md) §5 as items 22–25. #492 merged first (`40d5073c`) and
added items 14–21, including the 13 vs 14 Nov issue date as its item 16, so these four were renumbered from 14–17 to
22–25.

## Not verified

- No full Gazette search for CERT-In amendments; "none found" is based on cert-in.org.in and web search (§3).
- The Jan Vishwas Act change to the s. 70B(7) penalty (secondary only).
- Whether any vendor offers an India-specific addendum or a negotiated notice period on enterprise contracts. We read
  only the public terms.
- Razorpay's contractual role: no DPA was found, and its terms don't use "processor" or "fiduciary".
- The 13 vs 14 Nov 2025 issue date of G.S.R. 843(E) (Gazette No. 757) and the Rules (G.S.R. 846(E), Gazette No. 760)
  (open counsel question 16).

## Sources

| ID    | Source (all fetched 2026-11-12 IST)                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-G1 | G.S.R. 843(E), Gazette No. 757, signed 14 Nov 2025: https://egazette.gov.in/WriteReadData/2025/267647.pdf (MeitY copy of the same e-Gazette ID: https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf) |
| V3-G2 | G.S.R. 846(E), DPDP Rules, 2025, Gazette No. 760 (masthead 13 Nov 2025; ID CG-DL-E-14112025-267650): https://egazette.gov.in/WriteReadData/2025/267650.pdf                                                                            |
| V3-G3 | MeitY copy of the Rules: https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf                                                                                                                         |
| V3-G4 | MeitY DPDP Rules page (corrigendum listed as published 16.12.2025): https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa                                                       |
| V3-G5 | G.S.R. 892(E), corrigendum, Gazette No. 806: https://egazette.gov.in/WriteReadData/2025/268455.pdf (same file as MeitY's https://cdnbbsr.s3waas.gov.in/s35352696a9ca3397beb79f116f3a33991/uploads/2026/01/202601142078207557.pdf)     |
| V3-C1 | CERT-In directions page, "Last Updated On November 12, 2026": https://www.cert-in.org.in/Directions70B.jsp                                                                                                                            |
| V3-C2 | CERT-In Directions No. 20(3)/2022-CERT-In, 28 Apr 2022: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf                                                                                                          |
| V3-C3 | CERT-In FAQs, May 2022 (PDF created 18 May 2022): https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf                                                                                                          |
| V3-C4 | CERT-In extension, 27 Jun 2022: https://www.cert-in.org.in/PDF/CERT-In_directions_extension_MSMEs_and_validation_27.06.2022.pdf                                                                                                       |
| V3-C5 | CERT-In AI Security Auditing Guidelines v1.0, 4 Nov 2026: https://www.cert-in.org.in/PDF/AI_Security_Auditing_Guidelines.pdf                                                                                                          |
| V3-V1 | AssemblyAI Data Processing Addendum, effective and last modified 22 Jan 2026: https://www.assemblyai.com/legal/data-processing-addendum                                                                                               |
| V3-V2 | Google Cloud Data Processing Addendum, last modified 30 Oct 2026: https://cloud.google.com/terms/data-processing-addendum                                                                                                             |
| V3-V3 | Google Data Processing Addendum for Products Where Google is a Data Processor, Version 10, 7 May 2026: https://business.safety.google/processorterms/                                                                                 |
| V3-V4 | Gemini API Additional Terms of Service, effective 23 Mar 2026: https://ai.google.dev/gemini-api/terms                                                                                                                                 |
| V3-V5 | Resend Data Processing Addendum, last update 31 Dec 2025: https://resend.com/legal/dpa                                                                                                                                                |
| V3-V6 | Razorpay Terms & Conditions: https://razorpay.com/terms/                                                                                                                                                                              |
| V3-V7 | Razorpay Privacy Policy, effective 23 Feb 2026: https://razorpay.com/privacy/                                                                                                                                                         |
| V3-V8 | Razorpay blog, "Payment Gateway Compliance in 2026", 6 Apr 2026 (vendor statement, not a term): https://razorpay.com/blog/payment-gateway-compliance/                                                                                 |
| V3-V9 | Google Cloud Platform services summary: https://cloud.google.com/terms/services                                                                                                                                                       |
| V3-R1 | RBI Master Direction on Regulation of Payment Aggregators, 15 Sep 2025, updated as on 11 Nov 2026: https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896                                                                  |
| V3-R2 | RBI circular, Storage of Payment System Data, 6 Apr 2018: https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11244                                                                                                               |
| V3-R3 | RBI FAQs, Storage of Payment System Data, display date 26 Jun 2019: https://rbi.org.in/CommonPerson/english/Scripts/FAQs.aspx?Id=2995                                                                                                 |
| V3-S1 | dpdprules.org, corrigendum summary; **secondary**: https://dpdprules.org/blog/dpdp-rules-corrigendum-gsr-892e                                                                                                                         |
| V3-S2 | NHI guide to the CERT-In directions, checked 27 Oct 2026; **secondary**: https://nhimg.org/cert-in-directions-2022-guide                                                                                                              |
