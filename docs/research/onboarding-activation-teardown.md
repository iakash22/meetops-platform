# Onboarding and activation teardown: competitors vs MeetOps

- Checked: **2026-11-18 (IST)**. Repo facts come from `integration/phase-1` at `e5075890` (#483 merge, 14:22 IST).
  - #511 changed only `docs/research/`.
  - #483 changed the consent-method choice in `upload-button.tsx` (L83–86) and the contracts consent constants. None
    of the lines cited here changed.
  - Every competitor fact comes from a public page that we fetched on 2026-11-18 IST. The page's own "updated" date is given where it shows one.
- **No accounts were created** on any competitor product, and no one was contacted. Sources are limited to public help
  centres, official blogs, store listings, vendor docs and public review pages.
- Labels:
  - **INFERRED**: our reading of the docs, not stated in them.
  - **ESTIMATE**: our own count or number.
  - **PROPOSAL**: a suggestion that hasn't been decided.
  - **QUALITATIVE**: review or anecdote evidence, not a measurement.
- Step counts are ESTIMATES. We count clicks or screens a new user must act on, from the documented flow. They are
  not timed usability tests.
- **Not legal advice.** Consent wording and analytics consent are for counsel.
- A separate dated section, §8, corrects the merged briefs after #513. It is subject to the coordinator's
  no-objection.

## 1. Summary

1. **Everyone else front-loads the calendar; we don't need it.**
   - Fireflies, tl;dv and Read connect the calendar during SSO signup or in the first wizard screen [OA5, OA18, OA19].
   - Their first summary then waits for the next real meeting, and the bot has to be admitted.
   - Our first summary needs no calendar or bot: a browser-tab recording or a file upload is enough. That is an
     advantage we don't surface. The empty state says only "Upload or record a meeting."
2. **Granola is the only one with a pre-filled demo meeting**: a 2-minute tutorial "already waiting" at first sign-in
   [OA25]. Read shows a demo video after its wizard [OA19]. Fathom's Zoom app runs a "Guided Test Call" [OA14].
   Nobody else we checked documents a sample summary.
3. **Platform assistants have the shortest path when an admin has already enabled them.**
   - Gemini "Take notes for me" turns on by default for meetings with 3 or more guests in Business Standard/Plus
     from late Sep 2026. The admin help says "on or after September 21, 2026"; the Updates blog says it takes effect
     29 Sep [OA31, OA32].
   - Zoom has an account-level "Auto-start when meetings start" option [OA27].
   - Copilot needs an add-on licence and a transcription policy [OA28].
   - INFERRED: our real competition for an admin-enabled customer is "zero steps", not another bot.
4. **Our counts (ESTIMATE).**
   - Browser recording: **9 actions plus a processing wait**. Email signup forces verify, then log in, then a
     manual org, then a manual meeting.
   - With Google sign-in: about 7.
   - Upload path: about 8.
   - Extension path: about 12.
   - The best-documented competitors need **3–5 actions** before they wait for a calendar meeting (§4).
5. **Biggest friction we add (ESTIMATE/INFERRED):**
   - a mandatory org-creation step;
   - same-browser email verification;
   - a meeting record that must exist before capture;
   - a mobile app that dead-ends with no org ("Ask an admin for an invite").
6. **Code findings that block activation outright** (§7, for routing):
   - The summary and transcription workers default off.
   - Production extension builds use a stub upload client.
   - Desktop browser sign-in is behind a flag.
   - The repo has no activation instrumentation.

## 2. Competitors: signup to first useful summary

### 2.1 Path per product (from public docs)

| Product               | Documented steps to first summary                                                                                                                                                                                                                                     | Calendar and OAuth prompt                                                                                                                                                  | Extension, desktop or bot?                                                                                                                            | Auto-join default                                                                                                                                                            | Time-to-value claim                                                                             | Sources        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------- |
| **Otter**             | Sign up, then verify email ("You will need to verify your email before being able to use Otter"). Then either connect a calendar (Apps, Add, Allow) or Record / Import a file.                                                                                        | Optional. Google "Allow"; Microsoft "Yes". Otter recommends asking the Microsoft admin "to grant calendar permissions before connecting". Only the primary calendar syncs. | Notetaker bot joins calendar meetings. Mobile app for in-person. File import.                                                                         | Up to 5 modes, from "Meetings with a video link" to "Meetings I manually select". The default isn't named. A G2 reviewer (1 Nov 2026) says it auto-joined by default [OA36]. | None found on the help pages.                                                                   | OA1–OA4, OA36  |
| **Fireflies**         | "Continue with Google/Microsoft", then credentials, then a calendar checkbox, then review meeting settings, then Continue. Then the next meeting, or Upload. "No downloads or technical setup required."                                                              | Calendar access is part of SSO signup (checkbox). One calendar per account.                                                                                                | Bot (`fred@fireflies.ai`). Must be admitted from waiting rooms. Upload: MP3, M4A, WAV, MP4, WEBM.                                                     | **Joins all calendar meetings with a web-conference link and sends recaps to everyone on the invite** by default.                                                            | "It can take 5–10 minutes for a transcript". Live Assist gives "instant" summaries.             | OA5–OA10, OA37 |
| **Fathom**            | Connect calendar, then download the desktop app ("strongly recommend"), then settings (auto-record, auto-share), then open the app and log in, then "Test it out" in the next meeting. The Zoom-app path: Add, Authorize, connect calendar, "Start Guided Test Call". | Calendar authorization prompt. The Zoom app needs a paid Zoom account and the host.                                                                                        | Desktop app. Chrome extension for bot-free Meet (macOS 14.2+). Bot fallback. Chrome can disable the extension "after an update adds new permissions". | Settings offer All, External, Internal or No meetings. The quick start pushes "Auto-record for all meetings".                                                                | Store listing: "Get set up in minutes"; summary "the moment your call ends".                    | OA11–OA15      |
| **tl;dv**             | SSO login, which auto-connects the calendar. Then onboarding panels (auto-record, auto-share). Then the next meeting, or "Record now" with a pasted Meet URL.                                                                                                         | The calendar consent screen is part of Google/Microsoft SSO. A "Calendar permissions needed" banner appears if the user skipped it.                                        | Bot. Chrome extension to "Admit and Record" in Meet. Desktop app for manual Zoom/Teams.                                                               | All, Internal, External, Selected or No meetings. The docs "highly recommend" All.                                                                                           | None found on the help pages.                                                                   | OA16–OA18      |
| **Read.ai**           | Create account, then wizard "Which calendar…?" with authorization, then join and recap settings, then connect Zoom (needed for Zoom), then Finish, then a demo video.                                                                                                 | Calendar in the first wizard screen. Skipping it leaves a "Complete Your Account Setup" banner. M365 may need admin approval.                                              | Bot. Desktop app for other platforms. A Zoom account connection is required, because Zoom now requires bots to be authorized by a signed-in user.     | **"By default, Read AI joins all your meetings"** to use the 7-day trial. Recaps go to "People with access" by default.                                                      | None found.                                                                                     | OA19–OA24      |
| **Granola**           | Download, install, open, then sign in (browser) with calendar permissions ("Select all"). Then allow mic and system audio (macOS). Then a **demo meeting** is already waiting.                                                                                        | Calendar scopes in the sign-in flow. Cloud M365 only.                                                                                                                      | Desktop/mobile app, **no bot**. It captures device audio.                                                                                             | Not a bot. A notification arrives 1 minute before meetings with 2 or more attendees, and a click starts transcription.                                                       | "Setup takes under 5 minutes" (blog, 18 Feb; the year isn't shown, and the text mentions 2026). | OA25, OA26     |
| **Zoom AI Companion** | An admin enables "Meeting summary with AI". The host starts it, or the "Auto-start" sub-setting is on. The summary "will be automatically sent after the meeting has ended".                                                                                          | None for the user (it's inside Zoom).                                                                                                                                      | None. Requires a paid Zoom Workplace plan.                                                                                                            | Off unless the admin turns on "Auto-start when meetings start". A "Remind me to turn on AI" option exists.                                                                   | None.                                                                                           | OA27           |
| **Copilot in Teams**  | The admin assigns an add-on Microsoft Copilot licence and sets a transcription policy. The user selects Copilot in the meeting. For after-meeting use, transcription must be on.                                                                                      | None (inside M365).                                                                                                                                                        | None.                                                                                                                                                 | The organizer's Copilot setting per meeting. Admins can set the default to Off by policy.                                                                                    | None.                                                                                           | OA28, OA29     |
| **Gemini in Meet**    | An eligible Workspace edition. Click "Take notes for me", then Start, or it auto-starts per admin or user setting. The notes doc arrives "shortly after the meeting ends".                                                                                            | None (inside Workspace).                                                                                                                                                   | None.                                                                                                                                                 | **On by default for meetings with 3 or more guests for Business Standard/Plus from late Sep 2026** (21 or 29 Sep, per source). Off by default for Enterprise.                | None beyond "shortly after".                                                                    | OA30–OA32      |

### 2.2 Activation tactics seen

| Tactic                            | Who documents it                                                                                                                           | Notes                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Pre-filled demo or sample meeting | Granola (2-min tutorial meeting waiting at first sign-in, re-openable at `grano.la/demo`) [OA25]                                           | The closest analogue to a "pre-filled sample meeting".                                     |
| Demo video after onboarding       | Read [OA19]                                                                                                                                | Passive.                                                                                   |
| Guided test call                  | Fathom Zoom app [OA14]                                                                                                                     | Has the user end a real test meeting.                                                      |
| Instant record without a calendar | Otter (record), tl;dv ("Record now" with a URL), Fireflies (Live Assist; invite to a live call), Granola (New Note) [OA4, OA16, OA7, OA25] | A fallback when there's no scheduled meeting.                                              |
| File upload or import             | Otter, Fireflies [OA4, OA8]                                                                                                                | The fastest route to a summary without a meeting.                                          |
| Templates                         | Granola ("1-on-1, Stand-up, Weekly Team Meeting") [OA26]                                                                                   | Applied after capture.                                                                     |
| Aggressive defaults               | Fireflies and Read (join all, recap to all invitees) [OA5, OA20]                                                                           | Read warns that users "are then surprised when Read starts joining all of their meetings". |
| Setup banners                     | tl;dv ("Calendar permissions needed"), Read ("Complete Your Account Setup") [OA18, OA21]                                                   | Persistent nudges for skipped steps.                                                       |

## 3. Where competitors lose users (QUALITATIVE, public evidence only)

We have no competitor funnel data. This section lists **documented friction**: vendors write help articles about it,
and reviewers mention it. It is not drop-off rates.

1. **Bots blocked by waiting rooms and hosts.**
   - Fireflies: "the Notetaker must be admitted… If Fireflies is waiting to be admitted, capture won't start" [OA6].
   - Fireflies and tl;dv both document Google Meet labelling their bot a "potential risk" or "security risk", with only a
     Deny button visible at first. Users have to use the ⋮ menu to admit it [OA6, OA16].
2. **Zoom now requires bot authorization.**
   - From 2 Mar 2026, Meeting SDK apps joining meetings hosted by external accounts need an OBF or ZAK token [OA33].
   - Read: "You will need to connect your Zoom account… Read can only join… if you're in the meeting, signed in to
     that same Zoom account" (updated 13 Nov 2026) [OA23]. Fathom documents the same 2 Mar 2026 change [OA14].
3. **Microsoft 365 admin consent.**
   - Entra lets tenants restrict user consent, for example to verified publishers only [OA35].
   - Read has a dedicated article on "AADSTS7000112, 'Need admin approval'" [OA24].
   - Otter tells users to contact their Microsoft admin first [OA2].
4. **Google OAuth verification.**
   - Apps that request sensitive or restricted scopes without completing verification show an "unverified app" screen.
     They are capped at **100 new users** [OA34].
   - Verification "might require several months" for sensitive data [OA34].
   - We didn't find this on competitor pages. It applies to us (§5.2, P7).
5. **Extension permission prompts.** Fathom: "Chrome can turn the extension off after an update adds new
   permissions. Open chrome://extensions and approve the request" [OA13].
6. **Surprise auto-join and recaps.** These are a privacy complaint rather than a drop-off, but they are documented on
   both sides:
   - Read warns about it in its own setup guide [OA19].
   - G2 reviewers:
     - Otter, 1 Nov 2026: "the default setting was that it would ask to auto-join each video call… I was receiving
       transcriptions of calls that did not need notes taking" [OA36].
     - Fireflies, 5 May 2026: "auto-join behavior can feel pretty aggressive by default… it may end up joining private
       1-on-1s meetings uninvited" [OA37].
     - Fireflies, 28 Apr 2026: "I don't like that… the bot is asking permission to join the meetings" [OA37].
   - **INFERRED:** auto-join-all drives fast activation and also generates the "creepy bot" backlash.
7. **Praise for fast setup** (the counter-signal). G2, Otter, 14 Nov 2026: "I connected my calendar and linked
   Google Meet and Teams in a few minutes, with no IT involvement" [OA36].
8. **Review sites we couldn't read.**
   - Capterra returned a Cloudflare block to our fetch.
   - Chrome Web Store review tabs need a sign-in, and we did not sign in.
   - So review themes come from G2 only, and they are a small, non-random sample (QUALITATIVE).

## 4. Our current flow (repo at `e5075890`)

### 4.1 Web signup, auth and org

- **Routes.**
  - Public: `/login` and `/signup` (`apps/web/src/routes/router.tsx` L182, L217).
  - The app guard redirects to `/login` (L260).
  - Org creation is at `/organizations/new` (L359).
- **Email signup.**
  - Fields are name, email and password (8–128 characters, with a letter, number and symbol). The API returns 202
    (`docs/04-api/auth-and-orgs.md` L22).
  - The UI then shows "Verify your email … Open it to activate your account, then log in"
    (`apps/web/src/features/auth/forms.tsx` L203, L209).
- **Verification is bound to the registering browser.**
  - Signup sets a 24-hour `meetops_sid_signup` cookie (`docs/04-api/auth-and-orgs.md` L79).
  - A user who opens the email on another device "also loses the password they chose and has to set a new one" (L84).
  - This is a deliberate anti-squatting trade-off (PR #459), not a bug.
- **Google sign-in.**
  - It renders only when `GET /auth/providers` returns google.
  - A new verified Google email creates the account (`docs/05-web/auth-pages.md` L35–38).
  - No magic link, passkey or enterprise SSO.
- **The auth pages show a mock summary card** (`apps/web/src/features/auth/auth-layout.tsx` L141,
  `data-testid="mock-summary"`). It is the only "sample summary" a new user sees.
- **No automatic org.**
  - After login, the dashboard says "You don't belong to an organization yet", with a **Create organization** button
    (`apps/web/src/pages/app-pages.tsx` L87, L91).
  - The form has a single "Organization name" field (`apps/web/src/features/organizations/create-organization.tsx`
    L72–73).
- **Empty state:** "No meetings yet / Upload or record a meeting." (`app-pages.tsx` L18).

### 4.2 Calendar connect (optional)

- Google requests `calendar.events.readonly` and `calendar.calendarlist.readonly`
  (`packages/integrations/src/calendar.ts` L99–102).
- Outlook requests `Calendars.Read` and `User.Read`, plus `openid`, `profile`, `email` and `offline_access`
  (`packages/integrations/src/calendar-outlook.ts` L33–42). _Correction 2026-11-18: Outlook requests only
  `Calendars.Read`, `User.Read` and `offline_access` (`packages/integrations/src/calendar-outlook.ts` L248);
  `openid`, `profile` and `email` are only tolerated in the grant check, not requested._
- The connection is separate from sign-in and lives on `/calendar` (`router.tsx` L307). No capture path requires it.

### 4.3 First recording and upload (web)

- **Meeting first.**
  - The Meetings list has a create dialog and an Upload button (`apps/web/src/features/meetings/meetings-pages.tsx`
    L148–149).
  - The meeting page has Upload, the consent panel and the recording panel (L223, L228, L238).
- **Browser recording.**
  - The user must pick one of "Everyone on the call was told it is recorded" or "Everyone on the call agreed to be
    recorded" (`apps/web/src/features/recording/recording-panel.tsx` L12–13).
  - Start calls `getDisplayMedia({ audio: true, video: true })` (L110), so the browser's share picker appears.
  - After Stop: "Recording uploaded / Processing starts shortly." (L68).
- **Upload.** Pick, then client checks, then consent attestation, then hash, then presigned PUT, then complete
  (`apps/web/src/features/meetings/upload-button.tsx` L56–57).
  - An upload with no meeting is allowed by the service (`apps/api/src/modules/media/application/upload.service.ts`
    L66–76).
  - With `CONSENT_ENFORCEMENT_ENABLED` on, "an upload with no meeting… fails closed" (L70–71;
    `apps/api/src/modules/index.ts` L294–303, default off).
- **Summary display.** Report and transcript panels show when `status === 'completed'`
  (`apps/web/src/features/meetings/meetings-pages.tsx` L241–242). The page polls every 5 s while recording or
  processing, or every 30 s with realtime connected
  (`apps/web/src/lib/api/queries.ts` L37–41).

### 4.4 Extension

- **Permissions:** `activeTab`, `tabCapture`, `offscreen`, `storage` and `alarms`. No host permissions and no content
  scripts (`docs/05-web/extension.md` L23–33).
- **Consent:**
  - The notice is shown, then acknowledged. The acknowledgement is valid for 2 minutes and is one-shot per recording.
  - Then Start. Chrome's capture indicator stays visible (L35–41).
  - Notice text is in `apps/extension/src/lib/consent.ts` L9–12.
- **Pairing:**
  - "Pair with MeetOps" in the popup opens web `/extension/pair`, where the signed-in user confirms (L43–51).
  - Tokens live only in `chrome.storage.session` (L50).
  - INFERRED: Chrome clears session storage on browser restart, so the user would re-pair after each restart. This is
    not verified in a running build.
- **The web app has no "install the extension" link or store link.** The pair page only says "Open this page in
  Chrome with the MeetOps extension installed" (`apps/web/src/features/extension/pair-page.tsx` L138).

### 4.5 Desktop and mobile first run

- **Desktop (Tauri).**
  - Sign-in uses the ADR-012 browser + PKCE client only when `VITE_DESKTOP_BROWSER_AUTH=true`. Otherwise it is mock
    (dev only) or fail-closed (`apps/desktop/src/app.tsx` L151–158).
  - The sign-in screen's fallback text says "Browser sign-in (ADR-012) is not available yet"
    (`apps/desktop/src/features/auth/sign-in-screen.tsx` L15–19).
  - Recording lists only meetings with status `scheduled` or `recording`
    (`apps/desktop/src/features/recording/recording-screen.tsx` L69). A new user must create a meeting elsewhere first.
  - The user must confirm the notice ("Confirm that everyone in the meeting knows it is being recorded", L177–183)
    and grant the OS microphone permission.
- **Mobile (Expo).**
  - Demo mode (no `EXPO_PUBLIC_API_URL`) uses typed mocks and simulated capture. Live mode needs the API URL
    (`apps/mobile/src/services.ts` L53–56).
  - The consent sheet steps are `optIn`, `notice`, `mic` and `micDenied` (`apps/mobile/src/consent/ConsentSheet.tsx`
    L7). Start comes only after opt-in, the mic pre-prompt and the notice (`apps/mobile/src/screens/RecordScreen.tsx`
    L204–208).
  - **A new user with no org dead-ends at login:** "This account has no organization yet. Ask an admin for an
    invite." (`apps/mobile/src/screens/LoginScreen.tsx` L34). There is no org creation on mobile.

### 4.6 When the first summary appears

- **No latency target is documented.** We searched `docs/06-worker`, `docs/09-ai`, `docs/14-observability` and
  `docs/plans` for latency, p95 and SLO terms. The only latency alert is API p95 above 1 s
  (`docs/14-observability/alerts.md` L44–46).
- **The pipeline as coded:**
  1. Recording or upload complete.
  2. `media` queue.
  3. `transcription` queue (AssemblyAI, polled every 5 s by default, 30-minute total timeout;
     `apps/worker/src/ai/providers/assemblyai.ts` L141–142, L256).
  4. The summary trigger enqueues on the `ai` queue (`apps/worker/src/ai/worker.ts` L84;
     `apps/worker/src/ai/summary-trigger.ts` L70).
  5. Summary plus action items, then the meeting is `completed`.
- **Both AI workers are flag-gated and off by default:**
  - `TRANSCRIPTION_WORKER_ENABLED=false` and `AI_SUMMARY_WORKER_ENABLED=false` (`.env.example` L160, L163).
  - `apps/worker/src/index.ts` L79–85.
- **UNVERIFIED:** real end-to-end time. AssemblyAI's own turnaround isn't measured here.

### 4.7 Step count comparison (ESTIMATE)

The counts below are user actions to a first summary. Waits are excluded. "+P" marks a browser or OS permission
prompt.

| Path                               | Actions                | Detail                                                                                                                                                          |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MeetOps web, email, record tab** | **9 + wait**           | 1 signup form, 2 verify link (same browser), 3 log in, 4 create org, 5 create meeting, 6 open meeting, 7 choose consent, 8 Start (+P share picker), 9 Stop      |
| MeetOps web, Google                | ~7 + wait              | 1 Continue with Google, 2 Google consent, then org, meeting, open, consent, Start (+P), Stop                                                                    |
| MeetOps web, upload                | ~8 + wait              | signup (3), org, create meeting, open, Upload and pick file, consent                                                                                            |
| MeetOps extension                  | ~12 + wait             | signup (3), org, find and install the extension (+P, no link from web), pair (popup), confirm on web, open meeting tab, toolbar click, acknowledge, Start, Stop |
| MeetOps mobile (new user)          | blocked                | No org creation on mobile (§4.5)                                                                                                                                |
| Fireflies                          | ~4 + next meeting      | SSO, credentials, calendar checkbox, settings Continue; the bot must be admitted                                                                                |
| tl;dv                              | ~3 + next meeting      | SSO (calendar included), onboarding panels; admit the bot                                                                                                       |
| Read.ai                            | ~5 + next meeting      | create account, calendar choice and auth, settings, (Zoom connect), Finish                                                                                      |
| Otter                              | ~3 + meeting or import | sign up, verify email, then Record, Import or connect calendar                                                                                                  |
| Fathom                             | ~5 + next meeting      | calendar, download desktop app, settings, open and log in, test meeting                                                                                         |
| Granola                            | ~5 + demo **instant**  | download and install, sign in with calendar, allow mic (+P), allow system audio (+P), open the demo meeting                                                     |
| Zoom / Gemini / Copilot            | 0–2                    | Admin-enabled: auto-start, or one click on Summary / Take notes / Copilot                                                                                       |

INFERRED: we are slowest to a first summary for a solo signup, and fastest once the user is set up, because no
waiting for a calendar meeting or a bot admit is needed.

## 5. Gaps and proposals (PROPOSAL, nothing decided)

### 5.1 Targets

- **P1. Time-to-first-summary (TTFS) target.** Two candidate targets:
  - median signup-to-first-`completed` summary **≤ 10 min** on the upload or sample path;
  - processing p50 **≤ 3 min** for a 30-minute recording.
    These are placeholders until §6 events give a baseline. Owner: Backend/AI with the coordinator.
- **P2. A summary-ready signal.**
  - Email or in-app "Your summary is ready" on `completed`, so the user doesn't need to keep the tab open.
  - `docs/plans/notifications-architecture.md` already plans the channels. This is not checked against shipped
    notification types.

### 5.2 Fewer steps before value

- **P3. A pre-filled sample meeting.**
  - On first org creation, insert a clearly labelled **Sample** meeting with a synthetic transcript, a summary and
    action items. No real person's data. It doesn't count toward hours, and it can be deleted.
  - It mirrors Granola's demo [OA25] and replaces the static mock card on the auth page.
- **P4. Upload-first or demo path.** The dashboard empty state gets two primary buttons:
  - "Upload a recording", which creates the meeting implicitly with the consent attestation and fixes the meeting-less
    upload ambiguity in §7 F4;
  - "Try a 2-minute sample".
- **P5. Auto-create a personal org** ("<first name>'s workspace", renamable) at first login. This removes action 4 on
  every path and unblocks mobile.
  - OPTION B is to keep the explicit step but pre-fill the name.
  - Needs Backend and Security review (org ownership and invite semantics).
- **P6. Meeting-optional capture.** Let Start on the dashboard create an untitled meeting, as the extension's
  `meetings/resolve` already does (`docs/05-web/extension.md` L80). This removes actions 5–6.
- **P7. Keep calendar connect deferred** (it already is). Prompt for it after the first summary, with the scopes
  explained, rather than at signup.
  - `calendar.events.readonly` is a Google **sensitive** scope ([verification-round-2.md](verification-round-2.md)
    row 1). Until sensitive-scope verification is done, users see the unverified-app screen and the 100-user cap
    applies. Verification can take months [OA34], so start it before a public launch.
  - Microsoft: publisher verification and a tenant admin-consent help page [OA35].
- **P8. Verification friction.**
  - Keep the anti-squatting rule. Make Google the primary button, and in the check-email state say "open the link in
    this browser".
  - OPTION: after a same-browser verify, sign the user in directly instead of "then log in". This needs a Security
    review.

### 5.3 Extension, desktop and mobile ordering

- **P9. Extension pairing order.**
  - Add "Get the Chrome extension" on the web, linking to the store once listed.
  - After install, the extension opens `/extension/pair` itself on first run, so pairing happens while the user is
    already signed in on the web.
  - Ask for consent at first Start, not at install.
  - Evaluate whether pairing must repeat after a browser restart (§4.4). Fixing that is a Security decision.
- **P10. Desktop first run.** Ship browser sign-in (ADR-012) enabled. Allow recording without a pre-created scheduled
  meeting (create on Start).
- **P11. Mobile first run.** Allow org creation, or the P5 auto-org, on mobile, so a phone-first signup isn't a dead end.

### 5.4 Empty states

- **P12. Empty states:**
  - No org: the P5 auto-org.
  - No meetings: Upload, Sample and Record, and "Connect calendar (optional)".
  - Processing: show the stage (uploaded, transcribing, summarising) and "we'll email you".
  - Failed: the reason code and a retry.
  - The extension popup when unpaired: one button that opens pairing.

### 5.5 Outline per team (PROPOSAL)

| Team               | Items                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend (web)     | Empty states (P12); Upload and Sample on the dashboard (P4); install-extension CTA (P9); Google-first auth copy (P8); calendar prompt after the first summary (P7); processing stage UI (P12) |
| Native / extension | Extension first-run opens pairing, consent at Start (P9); desktop browser auth on and create-on-Start (P10); mobile org creation or auto-org handling (P11)                                   |
| Backend            | Auto personal org (P5); implicit meeting on upload or record (P4, P6); sample-meeting seeding (P3); summary-ready notification (P2); activation events (§6)                                   |
| AI                 | TTFS and processing latency targets and measurement (P1); synthetic sample transcript and summary content (P3); confirm both AI workers are enabled where intended (§7 F3)                    |

## 6. Activation metrics to instrument (PROPOSAL, no PII)

**Today the repo has no product analytics.** A search of `apps/` and `packages/` for PostHog, Segment, Amplitude,
Mixpanel or `analytics.track` found nothing.

**Proposed approach:** emit server-side events from existing transactions. The worker already uses an outbox pattern
for alerts.

| Event                                            | When                                        | Properties (no PII)                                                        |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------- |
| `signup_started` / `signup_completed`            | Form submit / account created               | `method` (email, google), `surface` (web, mobile)                          |
| `email_verified`                                 | Verify succeeds                             | `same_device` (bool)                                                       |
| `org_created`                                    | Org row created                             | `mode` (manual, auto)                                                      |
| `first_meeting_created`                          | First meeting per org                       | `source` (dialog, upload, extension_resolve, calendar, sample)             |
| `capture_started` / `capture_completed`          | Recording session or upload init / complete | `surface` (web_tab, upload, extension, desktop, mobile), `duration_bucket` |
| `transcript_ready` / `summary_ready`             | Stage done                                  | `latency_bucket_s` since capture completed, `provider`                     |
| `processing_failed`                              | Terminal failure                            | `stage`, `error_code`                                                      |
| `summary_viewed`                                 | First open of a report                      | `seconds_since_signup_bucket`                                              |
| `calendar_connected`                             | OAuth done                                  | `provider`                                                                 |
| `extension_paired` / `extension_repair_required` | Pair or re-pair                             | `reason` code                                                              |
| `sample_opened`                                  | P3                                          | none                                                                       |

- **Identifiers:** opaque org and user UUIDs, or a salted hash.
- **Never include:** names, emails, meeting titles, transcript or summary text, IPs or user agents.
- **Derived metrics:**
  - activation rate (`summary_viewed` within 7 days of signup);
  - TTFS distribution;
  - step drop-off between the events above.
- Whether a cookie or consent banner is needed for client-side events is for counsel (not legal advice). Server-side
  events avoid most of that question.

## 7. Code findings to route (no code changed)

| #   | Finding                                                                                                                                                                                      | Where                                                                                                                          | Suggested owner         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| F1  | The docs say "Pairing endpoints aren't in the API yet", but pair, extension-token and refresh are implemented                                                                                | `docs/05-web/extension.md` L81 vs `apps/api/src/modules/extension-auth/application/extension-auth.service.ts` L194, L239, L285 | Native/extension (docs) |
| F2  | `WXT_FEATURE_HTTP_UPLOAD` is off in production builds, so production uses the stub upload client and extension recordings may never upload                                                   | `apps/extension/README.md` L14; `docs/05-web/extension.md` L79                                                                 | Native/extension        |
| F3  | `TRANSCRIPTION_WORKER_ENABLED` and `AI_SUMMARY_WORKER_ENABLED` default false. With them off, no summary ever appears. No deploy config in the repo sets them (searched `infra/`, `.github/`) | `.env.example` L160, L163; `apps/worker/src/index.ts` L79–85                                                                   | DevOps / AI             |
| F4  | The Meetings-list Upload has no `meetingId`. It fails closed when consent enforcement is on. Whether a meeting-less upload is ever transcribed is unverified                                 | `apps/web/src/features/meetings/meetings-pages.tsx` L149; `apps/api/src/modules/media/application/upload.service.ts` L66–76    | Backend / Frontend      |
| F5  | The desktop README still says "M1 scaffold… mocked sign-in… No recording yet". The code has recording, native upload and browser auth                                                        | `apps/desktop/README.md` L7 vs `apps/desktop/src/features/recording/`, `app.tsx` L151–158                                      | Native (docs)           |
| F6  | Desktop production sign-in works only with `VITE_DESKTOP_BROWSER_AUTH=true`. Otherwise it fails closed                                                                                       | `apps/desktop/src/app.tsx` L151–158                                                                                            | Native                  |
| F7  | Mobile has no org creation, so a new user is told to ask an admin                                                                                                                            | `apps/mobile/src/screens/LoginScreen.tsx` L34                                                                                  | Native / Backend        |
| F8  | No install link for the extension anywhere in the web app                                                                                                                                    | `apps/web/src/features/extension/pair-page.tsx` L138                                                                           | Frontend                |
| F9  | No activation instrumentation (§6)                                                                                                                                                           | `apps/`, `packages/`                                                                                                           | Backend                 |

## 8. Corrections to merged briefs after #513 (dated 2026-11-18, subject to the coordinator's no-objection)

These were re-checked against `1d7ba360` (#513) and are the same at `e5075890`. Dated correction notes were added in
place. The original text is kept.

1. **AssemblyAI deletes now exist** (45e8664e, 2026-11-18 13:46 IST).
   - After a chunk is durably stored, the worker enqueues `ai-provider-transcript-delete`: 5 attempts, exponential
     backoff from 2 s, 404 counts as success (`apps/worker/src/ai/provider-transcript-delete.ts` L22–25;
     _updated 2026-11-18: L24–27 at `2127fb46`_).
   - The job calls `DELETE v2/transcript/{id}` (`packages/ai-core/src/adapters/assemblyai.ts` L35, L191).
   - The job id is now written to the anchor `transcripts.provider_job_id` (`apps/worker/src/ai/prisma-repository.ts`
     diff in 45e8664e).
   - The delete worker runs only when transcription is enabled (`apps/worker/src/index.ts` L50–58).
   - **Still open:**
     - no periodic sweep for final failures, which only fire a hook and metric
       (`apps/worker/src/ai/provider-transcript-delete.ts` L100, L221 at `e5075890`;
       _updated 2026-11-18: L106–107 for the metric and L270, L334 for the hook at `2127fb46`, after #514_);
     - no backfill for transcripts made before 45e8664e;
     - Gemini has no delete call (unchanged).
   - Corrected: `account-deletion-erasure-brief.md` S5, §3 rows, §5 recommendation and C3; `pricing-packaging-v2.md`
     §8; `ai-provider-due-diligence.md` §1, §5.5 and §7.
2. **Provider tier labels and production guard** (b8eb5ffb).
   - `packages/ai-core/src/bootstrap.ts` labels gemini, assemblyai, ollama and faster-whisper `tier: 'free'` at L66,
     L81, L97 and L111. openai and deepgram are `tier: 'paid'` at L125 and L137.
   - In production, `assertProductionProviderDataTiers` refuses a free or undeclared tier for an enabled provider
     unless `AI_PROVIDER_DATA_TIER_<NAME>` is set to `paid` or `no-training` (`packages/ai-core/src/provider-data-tier.ts`
     L22–34, L52–95, L108–125; called at `bootstrap.ts` L179; _updated 2026-11-18: L181 at `2127fb46`_).
   - INFERRED: the env value is an operator declaration. The code can't check the real billing tier.
   - Corrected: `pricing-packaging-v2.md` §8 (was L50/L55) and `ai-provider-due-diligence.md` §1 and §7 (was L50/L55).
     The OpenAI price cite in `ai-provider-due-diligence.md` §2.5 is now L125 (was L72).
   - _Updated 2026-11-18 at `2127fb46`, after #514: the `provider-data-tier.ts` cites above (L22–34, L52–95,
     L108–125) are now `dataTierEnvName` L30–32 and `parseProductionDataTier` L34–42, `assessEnabledProviderDataTiers`
     L60–104, and `assertProductionProviderDataTiers` L120–135 with its doc comment from L115._
3. **Deepgram dropped from the SSRF default allowlist** (088dab3e).
   - `DEFAULT_ALLOWED_HOSTS` (`packages/ai-core/src/security/ssrf.ts` L122–125) now lists Gemini, AssemblyAI and
     OpenAI.
   - A note was added to `ai-provider-due-diligence.md` §1, whose four-host list was dated to `8b881166`.
4. **`apps/worker/src/index.ts` moved.**
   - The retention job the deletion brief cited at L73–89 is now the ADR-014 IP-retention block at L86–106.
   - L79–85 is now the summary worker.
   - Corrected in `account-deletion-erasure-brief.md` §3.
5. **`pricing-packaging-v2.md` §3.1.**
   - `apps/worker/src/ai/bootstrap.ts` `resolveAudio` moved from L88 to L89
     (_updated 2026-11-18: L90 at `2127fb46`, after #514_).
   - The `apps/worker/src/ai/providers/assemblyai.ts` cites (L143, L185–190, L188) are unchanged.

## 9. Not verified

- Real competitor step counts and timings. We had no accounts, so the counts come from the docs.
- Default auto-join for Otter and tl;dv (not stated on the pages we read).
- Fathom and Granola latency claims beyond marketing copy.
- G2 quotes are individual reviews. Capterra and Chrome Web Store reviews weren't readable.
- Whether `calendar.calendarlist.readonly` is sensitive. `calendar.events.readonly` is sensitive per verification-round-2.md.
- Whether extension pairing survives a browser restart.
- Which flags production deploys actually set.
- MeetOps end-to-end processing time.
- Whether a meeting-less upload is processed.

## Sources (fetched 2026-11-18 IST; page dates where shown)

| ID   | Source                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OA1  | Otter, Automatically add Otter Notetaker to your meetings: https://help.otter.ai/hc/en-us/articles/13674910923671                                                                                                                             |
| OA2  | Otter, Connect your Calendar and Contacts: https://help.otter.ai/hc/en-us/articles/360048070154                                                                                                                                               |
| OA3  | Otter, Choose which meetings Otter Notetaker records: https://help.otter.ai/hc/en-us/articles/26010355877911                                                                                                                                  |
| OA4  | Otter, Quick Start Guide (updated 1 Apr 2026): https://help.otter.ai/hc/en-us/articles/360049722894                                                                                                                                           |
| OA5  | Fireflies, How to create a Fireflies account: https://guide.fireflies.ai/articles/9016807101-how-to-create-a-fireflies-account                                                                                                                |
| OA6  | Fireflies, Fix auto-join settings: https://guide.fireflies.ai/articles/5074225515-fix-fireflies-auto-join-settings                                                                                                                            |
| OA7  | Fireflies, How to invite Fireflies to meetings: https://guide.fireflies.ai/articles/4335268657-how-to-invite-fireflies-to-meetings                                                                                                            |
| OA8  | Fireflies, Upload and transcribe files: https://guide.fireflies.ai/articles/3893959957-how-to-upload-and-transcribe-audio-or-video-files-in-fireflies                                                                                         |
| OA9  | Fireflies, Troubleshoot transcription issues ("5–10 minutes"): https://guide.fireflies.ai/articles/5736968288-troubleshooting-transcription-issues                                                                                            |
| OA10 | Fireflies, Instant Summaries with Live Assist: https://guide.fireflies.ai/articles/8790575096-instant-summaries-with-live-assist-get-post-meeting-summaries-instantly                                                                         |
| OA11 | Fathom, Start Here quick start: https://help.fathom.video/en/articles/276608                                                                                                                                                                  |
| OA12 | Fathom, Navigating the Settings page: https://help.fathom.video/en/articles/3239617                                                                                                                                                           |
| OA13 | Fathom, Using Fathom with Google Meet: https://help.fathom.video/en/articles/449472                                                                                                                                                           |
| OA14 | Fathom, Quick Start Guide: Fathom Zoom App: https://help.fathom.video/en/articles/688704                                                                                                                                                      |
| OA15 | Fathom, Chrome Web Store listing (updated 16 Nov 2026): https://chromewebstore.google.com/detail/nhocmlminaplaendbabmoemehbpgdemn                                                                                                             |
| OA16 | tl;dv, Recording meetings with Google Meet (24 Apr 2026): https://intercom.help/tldv/en/articles/14434461-recording-meetings-with-google-meet                                                                                                 |
| OA17 | tl;dv, Auto-record (8 May 2026): https://intercom.help/tldv/en/articles/14441473-auto-record                                                                                                                                                  |
| OA18 | tl;dv, Calendar integration and why it matters: https://intercom.help/tldv/en/articles/10256819-calendar-integration-and-why-it-matters                                                                                                       |
| OA19 | Read, How do I create a Read account?: https://support.read.ai/hc/en-us/articles/23264974446995                                                                                                                                               |
| OA20 | Read, Account setup guide part 3: https://support.read.ai/hc/en-us/articles/57202252610451                                                                                                                                                    |
| OA21 | Read, How do I connect my calendar? (updated 16 Nov 2026): https://support.read.ai/hc/en-us/articles/26340445031443                                                                                                                           |
| OA22 | Read, What meetings does Read join? (updated 22 Oct 2026): https://support.read.ai/hc/en-us/articles/10568150023059                                                                                                                           |
| OA23 | Read, Upcoming Changes to Zoom Meetings (updated 13 Nov 2026): https://support.read.ai/hc/en-us/articles/48409575283347                                                                                                                       |
| OA24 | Read, Microsoft Outlook Calendar Permission (updated 6 Nov 2026): https://support.read.ai/hc/en-us/articles/47879416515859 and "Why is Read blocked when I sign in? AADSTS7000112…": https://support.read.ai/hc/en-us/articles/57202167036435 |
| OA25 | Granola, Setup guide: https://docs.granola.ai/help-center/getting-started/setting-up-granola-for-the-first-time                                                                                                                               |
| OA26 | Granola blog, Free trial: get started in under 5 minutes (18 Feb): https://www.granola.ai/blog/granola-free-trial-get-started                                                                                                                 |
| OA27 | Zoom, Enabling or disabling meeting summary with AI (KB0057960): https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0057960                                                                                                    |
| OA28 | Microsoft Learn, Manage Copilot for Teams meetings and events (ms.date 11 Aug 2026): https://learn.microsoft.com/en-us/microsoftteams/copilot-teams-transcription                                                                             |
| OA29 | Microsoft Support, Use Copilot without transcribing or recording: https://support.microsoft.com/en-us/teams/copilot/use-copilot-without-transcribing-or-recording-a-teams-meeting-or-call                                                     |
| OA30 | Google Meet Help, "Take notes for me": https://support.google.com/meet/answer/14754931                                                                                                                                                        |
| OA31 | Google Workspace Admin Help, Manage automatic note-taking for Meet: https://knowledge.workspace.google.com/admin/meet/upcoming-changes-to-automatic-note-taking                                                                               |
| OA32 | Google Workspace Updates, settings take effect 29 Sep (22 Sep 2026): https://workspaceupdates.googleblog.com/2026/09/new-google-meet-take-notes-for-me-settings-for-admins-and-end-users-take-effect-September-29th.html                      |
| OA33 | Zoom Developer, FAQ: Updates to Meeting SDK authorization (OBF, 2 Mar 2026): https://developers.zoom.us/docs/meeting-sdk/obf-faq/                                                                                                             |
| OA34 | Google Cloud Help, Unverified apps: https://support.google.com/cloud/answer/7454865                                                                                                                                                           |
| OA35 | Microsoft Learn, Configure how users consent to applications: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent                                                                                         |
| OA36 | G2, Otter.ai reviews (reviews dated 1 Nov 2026 and 14 Nov 2026): https://www.g2.com/products/otter-ai/reviews                                                                                                                                 |
| OA37 | G2, Fireflies.ai reviews (reviews dated 5 May 2026 and 28 Apr 2026): https://www.g2.com/products/fireflies-ai/reviews                                                                                                                         |
