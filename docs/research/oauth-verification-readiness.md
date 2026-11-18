# OAuth verification readiness: Google and Microsoft

- Checked: **2026-11-18 (IST)**. Repo facts are from `integration/phase-1` at `2127fb46`. Each source row gives the
  date we fetched it and the page's own "last updated" date where it shows one.
- **Nothing was submitted.** We opened no Google Cloud, Search Console, Entra or Partner Center console. No one was
  contacted.
- Labels:
  - **PROPOSAL** means a suggestion that hasn't been decided.
  - **OPTION** means a decision for Akash.
  - **ESTIMATE** means our own number.
  - **INFERRED** means our reading, not stated by the source.
  - **UNVERIFIED** means we couldn't confirm it.
- **Not legal advice.** The privacy-policy and Limited Use wording is for counsel. Google itself says "We recommend
  seeking legal advice on what's right for your app" [G3].
- **Builds on, doesn't repeat:**
  - [verification-round-2.md](verification-round-2.md) §1 (scope classes, the three verification types, narrower
    calendar scopes);
  - `docs/HANDOFF.md` §5 item 1 (the Google Calendar OAuth client `GOOGLE_CALENDAR_*` is separate from the web-login
    client `GOOGLE_OAUTH_*`, L70);
  - the "Do not widen without Security review" notes in `packages/integrations/src/calendar.ts` L98 and
    `calendar-outlook.ts` L32;
  - [onboarding-activation-teardown.md](onboarding-activation-teardown.md) (merged in #515), §3 item 4 and P7. We didn't edit it.

## 1. Summary

1. **Only one Google scope needs Google's review: `calendar.events.readonly`.**
   - It is **sensitive**, so it needs brand verification plus sensitive-scope verification.
   - We request **no restricted scope**, so **CASA does not apply**.
   - There is no Gmail, Drive or Meet API scope anywhere in the code.
   - Sign-in uses only `openid email profile`, which are non-sensitive.
2. **`calendar.calendarlist.readonly` stays UNVERIFIED.** Google's public pages list it but don't classify it. Google
   says sensitive scopes are "indicated in the Google Cloud Console" [G5].
   - The only outside evidence is a developer's forum post calling both of our scopes "(sensitive, non-restricted)"
     [G17]. That is not Google's word.
   - PROPOSAL: drop it. The code reads only `id` and `summary` from it (§2.3).
3. **Google's stated timelines:** brand verification takes "2-3 Business days" and sensitive-scope verification "10
   Business days". Both are "not guaranteed" [G3].
   - Brand verification has to be **published** before data-access review can start [G1].
   - A compliant brand result expires if not published within 7 days [G1].
4. **The 100-user cap is per project and lifetime.**
   - It "applies over the entire lifetime of the project, and it cannot be reset or changed" [G3].
   - It counts "100 new users in total, after the app presents the unverified app screen" [G8].
   - Testing mode allows up to 100 listed test users, and their grants and refresh tokens **expire after 7 days** [G13].
   - The sign-in scopes are exempt from both limits [G13].
5. **Pilot (6–8 teams, per the design-partner kit §6).**
   - Calendar can run in **Testing** with listed test users. The background sync will then fail every 7 days and ask
     for a reconnect (§4).
   - Or the pilot can start without calendar, which capture and upload don't need.
   - Don't publish an unverified build "In production": it burns the lifetime cap.
6. **Microsoft.**
   - `Calendars.Read`, `User.Read` and `offline_access` need **no admin consent** [M6].
   - But risk-based step-up is "enabled by default" [M4]. It blocks user consent to newly registered multitenant apps
     that **aren't publisher verified** and ask for more than basic sign-in and profile [M1]. The user sees AADSTS90094
     "needs permission… that only an admin can grant" [M4].
   - So **publisher verification is the Outlook critical path.** It needs a verified Microsoft AI Cloud Partner Program
     (formerly MPN) account, Partner Global Account, and a DNS-verified publisher domain. It is free [M1].
7. **Code findings (§8):**
   - Google `events.list` fetches whole events, with no `fields=`, though only 9 fields are used.
   - The Outlook "identity scopes" comment doesn't match the request.
   - There is no admin-consent path.
   - The privacy URL comes only from env, and the repo has no Limited Use text.

## 2. Google scope inventory and classification

### 2.1 What the code requests (repo at `2127fb46`)

| Flow                                 | Where                                                                                                     | Scopes requested                                             | Notes                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web sign-in ("Continue with Google") | `apps/api/src/modules/auth/application/google-oidc.ts` L17 (`GOOGLE_LOGIN_SCOPE`), set on the URL at L244 | `openid email profile`                                       | Client `GOOGLE_OAUTH_*` (`.env.example` L31–33)                                                                                                                                         |
| Calendar connect                     | `packages/integrations/src/calendar.ts` L99–102, sent at L214                                             | `calendar.events.readonly`, `calendar.calendarlist.readonly` | Client `GOOGLE_CALENDAR_*` (`.env.example` L226–227). `access_type=offline`, `include_granted_scopes=false`, `prompt=consent`, PKCE S256 (L215–220)                                     |
| Calendar grant check                 | `calendar.ts` L141–147, L152–159                                                                          | none extra                                                   | `openid`, `email`, `profile`, `userinfo.email` and `userinfo.profile` are tolerated if Google adds them. Any other scope rejects and revokes the grant (L377–389)                       |
| Calendar background sync             | `apps/worker/src/calendar/sync.ts` L9, L221                                                               | same grant                                                   | `invalid_grant` marks the connection `error`, and the UI asks for a reconnect                                                                                                           |
| Gmail / Drive / Meet REST APIs       | none                                                                                                      | none                                                         | A search of `apps/` and `packages/` for `googleapis.com/auth` found only the lines above. `smtp.gmail.com` (`packages/config/src/index.ts` L46) is the SMTP default, not an OAuth scope |

API calls made with the calendar grant:

- `GET calendars/primary/events` with `timeMin`, `timeMax`, `singleEvents`, `orderBy` and `maxResults`, but no
  `fields` (`calendar.ts` L272–279).
- `GET users/me/calendarList/primary`, reading `id` and `summary` (L333–344).

Fields used from each event (L286–314): `id`, `start`, `end`, `status`, `conferenceData.entryPoints`, `hangoutLink`,
`htmlLink`, `summary`, `organizer.email`, and the attendee **count**.

Events are cached in `CalendarEvent` with `title`, times, `conferenceUrl`, `htmlLink`, `organizerEmail` and
`attendeeCount` (`packages/database/prisma/schema.prisma` L1473–1487). They are purged on disconnect
(`apps/api/src/modules/calendar/prisma.repository.ts` L294–296). The privacy policy must disclose this storage (§3.3).

### 2.2 Classification (Google sources, fetched 2026-11-18)

| Scope                                                                                           | Class                                     | Evidence                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`, `email`, `profile` (and `userinfo.email`, `userinfo.profile`)                         | **Non-sensitive**                         | The Sign-In scopes are "pre-filled in the Non-sensitive scopes section" [G1]. They are exempt from the Testing warning and the 7-day expiry [G13]                                                                                                                                                                                                             |
| `calendar.events.readonly` ("View events on all your calendars" [G6])                           | **Sensitive**                             | "Examples of sensitive scopes include reading events stored in Google Calendar" [G1]                                                                                                                                                                                                                                                                          |
| `calendar.calendarlist.readonly` ("See the list of Google calendars you're subscribed to" [G6]) | **Not restricted. Sensitive: UNVERIFIED** | Not on the restricted list [G2]. The scopes list [G5] and Calendar scope page [G6] print no class. Google: "Sensitive scopes, indicated in the Google Cloud Console" [G5]. A developer forum post (12 Oct 2026, not Google) lists both our scopes as "(sensitive, non-restricted)" [G17]. **To settle:** read the Data Access page when the project is set up |
| Any restricted scope                                                                            | **None requested**                        | The restricted families are Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient and Health [G2]. No Calendar scope is on the list                                                                                                                                                                                                                       |

### 2.3 Minimum scope set (PROPOSAL)

Our features list upcoming meetings with title, time, join link and organizer, link an event to a meeting, and
auto-link (`CalendarEventLink`, schema L1538–1545).

| Candidate                                        | Meaning [G6]                                              | Does it serve our features?                                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.events.readonly` (current)             | View events on all your calendars                         | Yes. We only read `primary`, so it is broader than needed                                                                                                                                                                                                  |
| `calendar.events.owned.readonly`                 | See the events on Google calendars you own                | **Probably**, since we read only `primary`, which the user owns. UNVERIFIED: whether invitations from others on the primary calendar are returned (verification-round-2 §1.4). Class UNVERIFIED (Console)                                                  |
| `calendar.freebusy` / `calendar.events.freebusy` | View your availability / see availability                 | **No.** FreeBusy returns busy intervals only. There is no title, join link or organizer [G15]                                                                                                                                                              |
| `calendar.app.created`                           | Make secondary calendars, and see and edit events on them | **No.** It covers only calendars our app creates, not the user's meetings                                                                                                                                                                                  |
| `calendar.calendarlist.readonly` (current)       | See the list of calendars you're subscribed to            | **Not needed** if we take the account id and label from the calendar connection's own identity. PROPOSAL: drop it and request `openid email` alongside, which are non-sensitive and already tolerated (L141–147). Code change plus a Security review (L98) |

**PROPOSAL:**

- **Target set:** `calendar.events.owned.readonly`, if a dev-project test shows invitations are returned; otherwise
  `calendar.events.readonly`. Add `openid email` for identity, and drop `calendar.calendarlist.readonly`.
- Either way, add `fields=items(id,status,summary,start,end,htmlLink,hangoutLink,conferenceData/entryPoints,organizer/email,attendees/email)`.
  We read `attendees` only to count them, so we could also drop attendee emails if the count isn't
  needed (ESTIMATE: no product impact).
- Google asks for "an explanation for why a narrower scope isn't sufficient" [G9]. The table above is the draft of
  that explanation.

## 3. Google verification requirements

### 3.1 The three tracks

| Track                   | Applies to us?                                         | What's needed                                                                                                                                                                                                                                                                                                                                                                                                                        | Google's stated time                                   |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Brand                   | **Yes** (External app that shows a name or logo [G10]) | App name, logo, user support email, developer contacts, home page, privacy policy and terms links, authorized domains verified in Search Console [G10, G1]. "Verify Branding" runs an automated check that "usually completes in a few minutes" and can escalate to manual review. Then **Publish branding** within 7 days [G1]                                                                                                      | "2-3 Business days" [G3, G10]                          |
| Sensitive scope         | **Yes** (`calendar.events.readonly`)                   | Published branding first. Declare all scopes on Data Access, add up to 3 doc links, a justification per scope with a "why narrower isn't sufficient" explanation, and a demo video [G1, G9]                                                                                                                                                                                                                                          | "10 Business days" [G3]; "can take up to 10 days" [G1] |
| Restricted scope + CASA | **No** (no restricted scopes)                          | For reference: annual assessment under App Defense Alliance CASA, based on OWASP ASVS, assurance level AL1 or AL2 by "user count, requested scopes, and other application-specific signals", "revalidated every year" [G7]. Renewal comes 12 months after the Letter of Assessment approval [G4]. **Cost:** "Google does not charge… fees"; the price is "agreed on between the developer and the assessor". No published range [G3] | "6 weeks" [G3]                                         |

### 3.2 Domain, home page and authorized domains

- **Authorized domains:**
  - Must list the top private domains used by the home page, privacy policy, terms, and the web client's **redirect
    URIs and JavaScript origins** [G10].
  - Ours: calendar redirect `${apiOrigin}/calendar/google/callback` (`apps/api/src/modules/calendar/service.ts` L127)
    and login redirect `GOOGLE_OAUTH_REDIRECT_URI` (`.env.example` L33).
  - INFERRED: if both sit on `meetops.ai` (the extension's default origins are `app.meetops.ai` and `api.meetops.ai`,
    `apps/extension/README.md` L12–13), one authorized domain is enough.
  - Who owns `meetops.ai` is UNVERIFIED.
- **Search Console:**
  - A project Owner or Editor account must verify each authorized domain [G9, G1].
  - A **Domain property** (DNS TXT) covers all subdomains, and DNS is "the only way to verify a Domain property" [G12].
- **Home page** [G1]:
  - publicly accessible;
  - its relevance to the app must be clear;
  - it describes the app's functionality and links to the privacy policy;
  - Play or Facebook pages don't count.
- **Privacy policy** [G1, G9]:
  - same domain as the home page;
  - linked from the home page and the consent screen, and the same document in both places;
  - discloses how the app "accesses, uses, stores, or shares Google user data";
  - in-product privacy notices are also expected [G9].
- **Our state:**
  - No home page in the repo.
  - The web app reads Terms and Privacy URLs from build env (`VITE_TERMS_URL`, `VITE_PRIVACY_URL`;
    `apps/web/src/features/auth/auth-layout.tsx` L174–187), because "the Terms/Privacy pages are owned outside this
    repo".
  - The extension's privacy link is unset by default (`apps/extension/README.md` L15;
    [capture-platform-policy.md](capture-platform-policy.md) row at L45).

### 3.3 Limited Use and AI

- **Limited Use** [G14]. Use data only for "user-facing features that are prominent in the requesting application's
  user interface". Transfers are allowed only for those features with consent, security, law, or M&A. Humans may read
  the data only with affirmative agreement, for security, for law, or in aggregate. There is no ads, broker or credit
  use.
- **Disclosure.** Google says a public statement is enough for verification [G3]:
  - "{App's} use of information received from Google APIs will adhere to Google API Services User Data Policy,
    including the Limited Use requirements."
  - Disclose calendar data separately from other data. Otherwise "we will interpret your disclosures as applying to
    user data from sensitive/restricted scopes" [G3].
- **AI.** Google user data may not be used "to create, train, or improve a machine learning or artificial intelligence
  model, including foundational models", and must be used "only for a personalized model to execute a user-facing
  feature" [G3].
  - INFERRED: calendar event titles aren't sent to the LLM today. Meeting summaries use the meeting's own title
    (`packages/ai-core/src/extraction/pipeline.ts` L81), and `link()` stores only ids
    (`apps/api/src/modules/calendar/service.ts` L355–378).
  - A web flow that copies an event title into a meeting title would change that. Not traced.
- **Draft disclosure points for counsel (PROPOSAL, not legal advice):**
  1. We read upcoming events from the primary calendar: title, times, join link, organizer email and attendee count.
  2. We store them to show and auto-link meetings, and purge them on disconnect.
  3. No AI training on Google user data, including by our LLM provider.
  4. No ads, sale or broker transfer.
  5. Read-only access; revoke at any time in the app or at Google Account connections.

### 3.4 Demo video and justification

- **Video** [G1]: unlisted YouTube, in English. It must show:
  - the full grant flow, including Google sign-in if used;
  - the consent screen showing the **app name**;
  - the address bar with **our OAuth client ID**;
  - each sensitive scope's feature in use.
- **Our storyboard (PROPOSAL, ~2–3 min):**
  1. Log in.
  2. Open `/calendar`, then Connect Google.
  3. The Google consent screen, zoomed on the app name and the `client_id=` in the URL.
  4. Back in MeetOps, upcoming events listed with title, time and join link.
  5. Link an event to a meeting, or show the auto-link.
  6. Disconnect and show the events gone.
  - It needs the **production client ID and domain**, so it can only be recorded after the domain and branding work.
- **Justification draft (PROPOSAL):**
  > MeetOps reads events on the user's primary Google Calendar (`calendar.events.readonly`) to list upcoming meetings
  > with their title, time, join link and organizer on the Calendar page, and to link a calendar event to the MeetOps
  > meeting where the user records or uploads it. We never write to the calendar. Narrower: freebusy scopes return no
  > titles or join links, and `calendar.app.created` covers only app-created calendars.

## 4. Unverified-app cap, Testing vs production, and the pilot

| Topic            | What Google says                                                                                                                                                                                                                      | Source       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Cap              | "100 new users in total, after the app presents the unverified app screen". Applies to apps using sensitive or restricted scopes                                                                                                      | [G8]         |
| Lifetime         | "applies over the entire lifetime of the project, and it cannot be reset or changed"; exhausting it can "cause Google sign-in to be disabled"                                                                                         | [G3]         |
| Rate limit       | A separate new-user authorization rate limit applies even to verified apps (`rate_limit_exceeded`)                                                                                                                                    | [G16]        |
| Testing          | Up to **100 test users**. "A test user consumes a project's test user quota once added". A warning screen appears. "Authorizations by a test user will expire seven days from the time of consent", and the refresh token expires too | [G13], [G18] |
| Exemption        | Requests for only name, email and profile (`openid`, `userinfo.*`), including Sign in with Google, are exempt from the test-user list, the warning and the 7-day expiry                                                               | [G13]        |
| Exceptions       | Verification isn't needed for personal or few known users, dev/test/staging projects in Testing, or Internal (same Workspace org)                                                                                                     | [G1]         |
| Workspace admins | Sensitive scopes "might be restricted by Google Workspace organization administrators"                                                                                                                                                | [G1]         |

**What this means for the pilot (6–8 teams, design-partner kit §6):**

- Users per team aren't fixed. ESTIMATE: 5–12 users each, so roughly 30–100 Google accounts.
- **Testing mode works under 100 test users, with a weekly reconnect.**
  - The worker marks the connection `error` on `invalid_grant` (`apps/worker/src/calendar/sync.ts` L221).
  - Every pilot user would reconnect calendar every 7 days. INFERRED: noticeable friction for a pilot.
  - Sign-in is unaffected because of the exemption.
- **UNVERIFIED:** whether removing a test user frees quota. "Consumes… once added" suggests it doesn't.
- A partner's Workspace admin may block an unverified or unconfigured app. Ask partners' IT in advance.

**OPTIONS for Akash:**

| Option                                            | What                                                                           | Trade-off                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **A. Pilot without Google Calendar**              | Capture and upload only. Calendar is optional today (onboarding teardown §4.2) | No review on the critical path. Loses auto-link and upcoming-meeting views                                   |
| **B. Calendar in Testing (recommended to start)** | List pilot users as test users in the calendar project                         | Up to 100 accounts; a 7-day reconnect; a warning screen. No lifetime cap burned                              |
| **C. Verify before the pilot**                    | Brand plus sensitive review first                                              | ESTIMATE: about 3–5 weeks from a live domain and policy (§6). Cleanest experience                            |
| D. Publish unverified "In production"             | —                                                                              | **Not recommended.** It shows the unverified screen and uses the lifetime 100-user cap, which can't be reset |

**Project layout (OPTION):**

- The two Google clients are separate (HANDOFF L70), but verification is per project (consent screen).
- **OPTION 1:** one project for both login and calendar. One branding, one review. The login client inherits the
  project's Testing or production state.
- **OPTION 2:** a login project published "In production" with brand verification only (non-sensitive scopes, no
  cap), and a separate calendar project kept in Testing until verified.
  - Google's policies require separate projects for testing and production [G11].
  - PROPOSAL: Option 2, plus separate dev projects.

## 5. Microsoft: publisher verification and admin consent

### 5.1 What the repo requests (Outlook calendar is implemented)

- **Authorize request:** `Calendars.Read User.Read offline_access`, with `prompt=select_account`, PKCE and
  `response_mode=query` (`packages/integrations/src/calendar-outlook.ts` L242–253).
  - `OUTLOOK_CALENDAR_SCOPES` is defined at L33.
  - `openid profile email` are only **tolerated** in the grant check (L35–40, L102). They aren't requested; see §8 C2.
- **Authority tenant:** `common` by default (L218, L228–229). `OUTLOOK_CALENDAR_TENANT` accepts `common`,
  `organizations`, `consumers`, a GUID or a verified domain (L41–71; `.env.example` L230).
- **Graph calls:**
  - `/me/calendarView` with `$select` = id, subject, start, end, isAllDay, isCancelled, showAs, webLink, organizer,
    attendees, onlineMeeting, onlineMeetingUrl (L76–77, L309–315). Attendees are only counted (L162).
  - `/me?$select=id,displayName,mail,userPrincipalName` (L430).
- **Redirect:** `${apiOrigin}/calendar/outlook/callback` (`apps/api/src/modules/calendar/service.ts` L127).

### 5.2 Permissions (Graph reference, ms.date 2026-09-14)

| Permission                          | Type      | Admin consent required | Note                                                                                                                                                                                   |
| ----------------------------------- | --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Calendars.Read`                    | Delegated | **No**                 | "Read user calendars". Available in personal accounts. The _application_ variant needs admin consent [M6]                                                                              |
| `User.Read`                         | Delegated | **No**                 | Sign in and read the profile [M6]                                                                                                                                                      |
| `offline_access`                    | OIDC      | **No**                 | Refresh tokens [M6]                                                                                                                                                                    |
| `Calendars.ReadBasic` (alternative) | Delegated | **No**                 | Reads events "except for properties such as body, attachments, and extensions" [M6]. PROPOSAL: narrower. UNVERIFIED: whether `onlineMeeting` and `onlineMeetingUrl` come back under it |

INFERRED from the Microsoft 365 Message Center (via an archive): the July–August 2025 "Microsoft managed" consent
policy change targets Files and Sites permissions, not calendar ones [M10].

### 5.3 When user consent is blocked

- **Default.** "By default, all users are allowed to consent to applications for permissions that don't require
  administrator consent". Microsoft recommends allowing consent only to verified publishers [M3]. Tenants may disable
  user consent or restrict it to verified publishers and low-impact permissions (`microsoft-user-default-low`) [M3,
  M7].
- **Risk-based step-up** is "enabled by default" and changes behaviour only where user consent is enabled [M4]. From November 2020, users "can't consent to most newly
  registered multitenant apps that aren't publisher verified". It applies to apps registered after 8 Nov 2020 that
  request "permissions that extend beyond the basic sign-in and read user profile", in other tenants [M1].
  - INFERRED: `Calendars.Read` is beyond basic, so an unverified MeetOps app gets AADSTS90094 for org users [M4].
  - If the tenant enabled the admin consent workflow, users can request approval from the prompt [M4, M8].
- **Admin consent URL** [M5]:
  - `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=…&scope=https://graph.microsoft.com/Calendars.Read …&redirect_uri=…&state=…`
  - Use a tenant id or `organizations`, never `common`.
  - Returns `admin_consent=True&tenant=<GUID>`.
  - Admins can also grant from the Entra admin center [M9].
  - **Not implemented in the repo** (a search for `adminconsent` found nothing).

### 5.4 Publisher verification requirements [M1, M2]

- A **Partner One ID** for a verified Microsoft AI Cloud Partner Program (CPP) account, which must be the **Partner
  Global Account**, not a location ID.
- The app registered with a **work or school** account (not an MSA) in an Entra tenant associated with that PGA.
- A **publisher domain** that isn't `*.onmicrosoft.com`. It must match the CPP verification email's domain or be a
  DNS-verified custom domain in the tenant.
- The person verifying needs the right Entra role plus **CPP Partner Admin or Account Admin** in Partner Center.
- Accept the Microsoft identity platform Terms of Use.
- **Cost:** none. "Developers who have already met these requirements can be verified in minutes". Not supported in
  national clouds.
- **UNVERIFIED:** how long Partner Center's own CPP account verification takes. Not stated on the pages we read.

## 6. Checklist for Akash (owners, sequence, timeline)

The sequence numbers are the order of work. "Akash" means a decision or account only he can make or own.

| #   | Item                                                                                                                            | Owner               | Depends on | Notes                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1   | Decide pilot option A, B or C (§4) and the project layout, OPTION 1 or 2                                                        | Akash               | —          | Decides the critical path                                                                     |
| 2   | Confirm the domain (e.g. `meetops.ai`) and DNS access                                                                           | Akash               | —          | Needed for Search Console (Google) and the publisher domain (Microsoft)                       |
| 3   | Google Cloud project owner (a company Google account, not personal) and an Organization, if Internal or a group owner is wanted | Akash               | 2          | Keep owners and editors current [G9]                                                          |
| 4   | Support email (shown on the consent screen) and developer contact emails                                                        | Akash               | 2          | A role alias on our domain (PROPOSAL)                                                         |
| 5   | Public home page on the domain: app description and a privacy link                                                              | Akash + Frontend    | 2          | Not in this repo                                                                              |
| 6   | Privacy policy and terms on the same domain, with the Google user-data section and the Limited Use statement (§3.3)             | Akash + counsel     | 2          | Not legal advice. Set `VITE_PRIVACY_URL` and `VITE_TERMS_URL` and the extension's privacy URL |
| 7   | App name and logo (consent screen)                                                                                              | Akash               | —          | UNVERIFIED: Google's logo size limits weren't on the pages we fetched                         |
| 8   | Verify the domain in Search Console (Domain property, DNS TXT)                                                                  | Akash or DevOps     | 2, 3       | Hours (ESTIMATE)                                                                              |
| 9   | Production OAuth clients and redirect URIs on the domain; authorized domains                                                    | DevOps              | 3, 8       |                                                                                               |
| 10  | Brand verification, then **Publish branding** within 7 days                                                                     | Akash               | 4–9        | 2–3 business days [G3]                                                                        |
| 11  | Scope narrowing (§2.3) and `fields=` (§8 C1), if accepted                                                                       | Backend + Security  | —          | Before recording the video, so the video matches the final scopes                             |
| 12  | Demo video (unlisted, English) and justification text (§3.4)                                                                    | Frontend/PM + Akash | 9, 10, 11  | Production client ID visible                                                                  |
| 13  | Submit sensitive-scope verification; answer Trust & Safety emails                                                               | Akash               | 10, 12     | 10 business days [G3], not guaranteed                                                         |
| 14  | Testing-mode test users for the pilot (option B)                                                                                | Akash/PM            | 3, 9       | Up to 100; a 7-day reconnect                                                                  |
| 15  | Partner Center (CPP) account enrolled and verified, as PGA; Partner Admin role                                                  | Akash               | 2          | Free; verification time UNVERIFIED                                                            |
| 16  | Entra app registration (multitenant, work account), publisher domain DNS-verified, publisher verification                       | Akash + DevOps      | 2, 15      | Minutes once prerequisites are done [M1]                                                      |
| 17  | Admin-consent fallback: a help page plus the admin-consent URL for pilot tenants (§5.3)                                         | Backend + Docs      | 16 or none | Lets pilot admins approve even before verification                                            |
| 18  | CASA budget                                                                                                                     | —                   | —          | **Not needed** (no restricted scopes). Revisit only if Gmail or Drive scopes are ever added   |

**Timeline (ESTIMATE, business days from the decision):**

| Weeks (ESTIMATE) | Work                                                           |
| ---------------- | -------------------------------------------------------------- |
| 1                | Items 1–4 and 7. Start item 15. Draft item 6 with counsel      |
| 1–2              | Items 5, 6, 8 and 9 go live                                    |
| 2                | Brand verification (10): 2–3 days. Items 11 and 12 in parallel |
| 3–5              | Sensitive review (13): about 10 business days plus follow-ups  |
| Parallel         | Microsoft: items 15–16, as soon as Partner Center verifies     |

- **Critical path (Google):** domain → privacy policy and home page live → Search Console → brand published → video
  with the production client → sensitive review. ESTIMATE: **about 3–5 weeks**, if counsel turns the policy around
  in about a week.
- **Critical path to the pilot:**
  - Option A: none.
  - Option B: items 3, 9 and 14, a few days (ESTIMATE).
  - Option C: the full Google path.
  - Outlook in a partner's tenant: publisher verification (15–16), or an admin consenting through the URL (17).

## 7. Not verified

- Whether `calendar.calendarlist.readonly` and `calendar.events.owned.readonly` are sensitive. Only the Cloud
  Console's Data Access page shows this.
- Whether `calendar.events.owned.readonly` returns events other people invite the user to.
- Whether `Calendars.ReadBasic` returns `onlineMeeting` and `onlineMeetingUrl`.
- Whether removing a Testing test user frees quota.
- Google logo size limits.
- How long Partner Center CPP verification takes.
- Who owns `meetops.ai`.
- Whether any web flow copies a calendar title into a meeting, and so to the LLM.
- Whether Microsoft step-up applies to consumer (MSA) users. The pages describe organization tenants.
- CASA price ranges. Google publishes none, and the App Defense Alliance pages need JavaScript, which our fetch
  couldn't render.

## 8. Code findings to route (no code changed)

| #   | Finding                                                                                                                                                                                                                                                                                                           | Where                                                                                      | Owner                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| C1  | Google `events.list` sends no `fields=`, so whole events are fetched (description, attendee emails and so on), though only 9 fields are used. Outlook already uses `$select`. Minimising helps the Limited Use and minimum-scope case                                                                             | `packages/integrations/src/calendar.ts` L272–279 vs L286–314; `calendar-outlook.ts` L76–77 | Backend                                          |
| C2  | The `OUTLOOK_IDENTITY_SCOPES` comment says "Requested alongside", but the authorize URL requests only `Calendars.Read User.Read offline_access`. `onboarding-activation-teardown.md` L160 (§4.2, from #515) repeats the claim (it should read "plus `offline_access`; `openid`, `profile` and `email` tolerated") | `calendar-outlook.ts` L34–40 vs L248                                                       | Backend (comment); Research (teardown follow-up) |
| C3  | `calendar.calendarlist.readonly` is used only for `id` and `summary`. It could be replaced by identity claims (§2.3)                                                                                                                                                                                              | `calendar.ts` L333–344                                                                     | Backend + Security                               |
| C4  | Both providers fetch the attendee list (with emails) but use only the count                                                                                                                                                                                                                                       | `calendar.ts` L309; `calendar-outlook.ts` L77, L162                                        | Backend                                          |
| C5  | No admin-consent endpoint or help flow for Entra tenants that block user consent. The default tenant `common` can't be used for admin consent [M5]                                                                                                                                                                | `calendar-outlook.ts` L218                                                                 | Backend + Docs                                   |
| C6  | The privacy and terms URLs are env-only. There is no home page or Limited Use text in the repo, and the extension's privacy URL is unset                                                                                                                                                                          | `apps/web/src/features/auth/auth-layout.tsx` L174–187; `apps/extension/README.md` L15      | Frontend + Akash                                 |
| C7  | Two Google clients (`GOOGLE_OAUTH_*`, `GOOGLE_CALENDAR_*`) and no documented project layout (§4 OPTION)                                                                                                                                                                                                           | `.env.example` L31–33, L226–227; `docs/HANDOFF.md` L70                                     | DevOps + Akash                                   |

## Sources (fetched 2026-11-18 IST)

| ID  | Source                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Google, Sensitive scope verification (updated 2026-11-10 UTC): https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification              |
| G2  | Google Cloud Help, Restricted scopes: https://support.google.com/cloud/answer/13464325                                                                                                |
| G3  | Google Cloud Help, OAuth verification FAQ: https://support.google.com/cloud/answer/13463817                                                                                           |
| G4  | Google, Restricted scope verification (updated 2026-11-10 UTC): https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification            |
| G5  | Google, OAuth 2.0 Scopes for Google APIs (updated 2026-09-14 UTC): https://developers.google.com/identity/protocols/oauth2/scopes                                                     |
| G6  | Google, Choose Google Calendar API scopes (updated 2026-09-03 UTC): https://developers.google.com/workspace/calendar/api/auth                                                         |
| G7  | Google Cloud Help, Security assessment: https://support.google.com/cloud/answer/13465431                                                                                              |
| G8  | Google Cloud Help, Unverified apps: https://support.google.com/cloud/answer/7454865                                                                                                   |
| G9  | Google Cloud Help, Verification requirements: https://support.google.com/cloud/answer/13464321                                                                                        |
| G10 | Google, Brand verification (updated 2026-11-10 UTC): https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification                                  |
| G11 | Google, OAuth policy compliance (updated 2026-11-10 UTC): https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance                              |
| G12 | Search Console Help, Verify your site ownership: https://support.google.com/webmasters/answer/9008080                                                                                 |
| G13 | Google Cloud Help, Manage App Audience: https://support.google.com/cloud/answer/15549945                                                                                              |
| G14 | Google API Services User Data Policy (updated 15 Feb 2024): https://developers.google.com/terms/api-services-user-data-policy                                                         |
| G15 | Google Calendar API, Freebusy: query (updated 2026-05-12 UTC): https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query                                       |
| G16 | Google Cloud Help, OAuth Application Rate Limits: https://support.google.com/cloud/answer/9028764                                                                                     |
| G17 | Google Developer forums (community post, not Google; 12 Oct 2026): https://discuss.google.dev/t/oauth-verification-stuck-homepage-verified-but-no-email-from-trust-safety-team/403746 |
| G18 | Google, Using OAuth 2.0 to Access Google APIs, refresh token expiration (updated 2026-10-29 UTC): https://developers.google.com/identity/protocols/oauth2                             |
| M1  | Microsoft Learn, Publisher verification (ms.date 2024-08-13): https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview                               |
| M2  | Microsoft Learn, Mark an app as publisher verified (ms.date 2024-05-31): https://learn.microsoft.com/en-us/entra/identity-platform/mark-app-as-publisher-verified                     |
| M3  | Microsoft Learn, Configure how users consent to applications (ms.date 2025-06-15): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent            |
| M4  | Microsoft Learn, Configure risk-based step-up consent (ms.date 2025-05-21): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent     |
| M5  | Microsoft Learn, Admin consent on the Microsoft identity platform (ms.date 2023-11-08): https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent                    |
| M6  | Microsoft Graph permissions reference (ms.date 2026-09-14): https://learn.microsoft.com/en-us/graph/permissions-reference                                                             |
| M7  | Microsoft Learn, User and admin consent overview (ms.date 2025-03-18): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview                   |
| M8  | Microsoft Learn, Configure the admin consent workflow (ms.date 2024-12-29): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-admin-consent-workflow         |
| M9  | Microsoft Learn, Grant tenant-wide admin consent (ms.date 2025-03-25): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent                           |
| M10 | Microsoft 365 Message Center MC1097272 "Secure by Default" (updated 18 Jul 2025), read via the community archive https://mc.merill.net/message/MC1097272 (a mirror, not Microsoft)    |
