# Capture platforms: store policy and consent UX gaps (web, extension, desktop, mobile)

- Checked: **2026-11-18 (IST)**. Each source row gives the page's own "last updated" date where the page shows one.
- Scope: what Chrome Web Store, Apple (App Store and macOS) and Google Play require of an app that records meeting
  audio, compared with what the repo does today on `integration/phase-1` at `d56f8819`. Desk research only: no store
  accounts, no submissions, no device builds.
- Labels: **gap** = something a store or OS rule requires that the repo doesn't have yet; **proposal** = our suggested
  fix, not decided; **interpretation** = our reading of a policy, not the store's. Store reviewers decide case by case,
  so passing this list doesn't guarantee approval.
- Not legal advice. Store policies are contract terms, not law; the consent law questions stay in
  [legal-questions-brief.md](legal-questions-brief.md) §5.
- Builds on, and doesn't replace, `docs/mobile/store-review.md`, `docs/mobile/plan.md` (M6),
  `docs/p9/release-checklist.md` §3–§5 and `docs/p9/remaining-work.md` items 14 and 16.

## 1. Summary

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Surfaces          | Teams                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------- |
| F1  | **No account deletion anywhere.** The mobile app lets people sign up (`apps/mobile/app/(auth)/signup.tsx`), and both Apple (5.1.1(v)) and Play (User Data policy) then require in-app account deletion; Play also wants a web deletion page linked in Play Console [P1, P11]. The API has no self-delete route, and ADR-020 blocks hard-deleting any user who attested consent.                                                                                                                      | API, web, mobile  | Backend, frontend, native |
| F2  | **No in-app privacy-policy link** outside the web auth pages. Apple and Play both require one inside the app; Chrome Web Store requires a posted policy [P1, P11, P13]. Web renders the link only when `VITE_PRIVACY_URL` and `VITE_TERMS_URL` are set (`apps/web/src/features/auth/auth-layout.tsx` L173–L187).                                                                                                                                                                                     | All               | Frontend, native, owner   |
| F3  | **Play now requires target API 36** for new apps and updates (since 31 Aug 2026) [P12]. The mobile app is on Expo `~52.0.49` (`apps/mobile/package.json`). Expo's version table now lists only SDK 56–58 (target 36) [P7], so SDK 52's target must be checked in a prebuild. This is a direct input to the open Expo/RN upgrade decision (HANDOFF §5.5).                                                                                                                                             | Mobile            | Native, owner             |
| F4  | **Apple builds need Xcode 26 / iOS 26 SDK** (since 28 Apr 2026) [P5]. Whether Expo 52 builds with Xcode 26 is **not verified**; same upgrade decision.                                                                                                                                                                                                                                                                                                                                               | Mobile            | Native, owner             |
| F5  | **macOS desktop has no `Info.plist` or entitlements.** Apple says `NSMicrophoneUsageDescription` "is required if your app uses APIs that access the device's microphone", and a hardened-runtime (notarised) app needs the Audio Input entitlement to record [P2, P3]. `apps/desktop/src-tauri/` has neither, while the webview recorder calls `getUserMedia({ audio: true })` (`apps/desktop/src/features/recording/recorder.ts` L31). Tauri merges a `src-tauri/Info.plist` into the bundle [P17]. | Desktop (macOS)   | Native                    |
| F6  | **No iOS privacy manifest configured.** Apple requires approved reasons for "required reason" APIs to upload a build (since 1 May 2024) [P4, P5]; Expo supports this through `expo.ios.privacyManifests` and warns that Apple may not parse library manifests from static CocoaPods [P6]. `apps/mobile/app.config.ts` has no `privacyManifests`.                                                                                                                                                     | Mobile (iOS)      | Native                    |
| F7  | **Play foreground-service declaration** for `microphone` (description, impact if deferred or interrupted, and a demo video) is still to file [P10]. The manifest side is done (`apps/mobile/plugins/withRecordingCompliance.js` L14–L43), but `docs/mobile/store-review.md` L37–L42 still says the service "isn't implemented"; that note is stale.                                                                                                                                                  | Mobile (Android)  | Native, owner             |
| F8  | **The extension records the tab only, not the user's microphone** (`apps/extension/entrypoints/offscreen/main.ts` L47–L52, `chromeMediaSource: 'tab'`). **Interpretation:** in a browser call the local user's voice is normally not played back into the tab, so the recording may miss the person who pressed Record. Needs a real-meeting test.                                                                                                                                                   | Extension         | Native (extension), AI    |
| F9  | **Store disclosures don't match the code yet.** Play's Data safety form and Chrome's privacy fields must match the privacy policy and behaviour [P11, P14]. The drafted Data safety text says the "user can request deletion" (`docs/mobile/store-review.md` L28), which F1 says isn't built.                                                                                                                                                                                                        | Mobile, extension | Native, owner             |

What is already in line with the policies (verified against the sources below): a per-recording consent step before
capture on every client; the Android `microphone` service type, `FOREGROUND_SERVICE_MICROPHONE` and `RECORD_AUDIO`
[P8]; a minimal extension permission set with no host permissions (`apps/extension/src/manifest.ts` L25–L39), which fits
Chrome's "narrowest permissions" rule [P13]; the offscreen `USER_MEDIA` reason [P16]; and replaying tab audio so the user
still hears the meeting, which Chrome's docs call out because a captured tab stops playing audio [P15]
(`apps/extension/entrypoints/offscreen/main.ts` L69–L71).

## 2. Per surface

### 2.1 Chrome extension (Chrome Web Store)

| Rule (source)                                                                                                                                         | Repo today                                                                                                                                      | Gap / proposal                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "If your Product handles any user data, then you must post an accurate and up to date privacy policy" [P13]                                           | No privacy URL in the extension or manifest                                                                                                     | **Gap.** Link the same policy as web (F2) from the popup and side panel; enter it in the dashboard                                                                        |
| Before installation, "prominently disclose what user data will be collected and how it will be used" and get "affirmative and informed consent" [P13] | Description: "Record meetings you are part of, with clear consent." Consent is per recording in the popup (`apps/extension/src/lib/consent.ts`) | **Proposal:** the store listing names audio capture, upload to the org's MeetOps workspace and AI processing. The in-popup notice already gives consent at first use      |
| Use the "narrowest permissions"; don't "future proof" [P13]. Every permission must be justified in the dashboard, or the item is rejected [P14]       | Six permissions, each explained in `apps/extension/src/manifest.ts` L7–L25                                                                      | Reuse those comments as the dashboard justifications. Adding `notifications` (planned in `docs/plans/notifications-architecture.md` L318) triggers a new review           |
| Limited Use: data only for the "single purpose"; an affirmative Limited Use statement on our website [P13, P19]                                       | Not present                                                                                                                                     | **Gap.** Add the statement to the privacy policy page. **Interpretation:** sending meeting audio to AI sub-processors is within the single purpose if the listing says so |
| `tabCapture` needs a user invocation and `activeTab`; a stream ID from the service worker can be used in an offscreen document [P15]                  | Popup click → `getMediaStreamId` → offscreen `getUserMedia` (`apps/extension/entrypoints/background.ts` L238)                                   | In line                                                                                                                                                                   |
| A captured tab "will no longer be played" to the user unless the audio is routed back [P15]                                                           | Routed back through an `AudioContext`                                                                                                           | In line                                                                                                                                                                   |

The notice in `CONSENT_NOTICE` says recording "is visible in Chrome's tab indicator". We didn't find that indicator
described on the `tabCapture` reference page [P15]; **not verified** from a primary source here, so check it on a real
build before relying on it in store text.

### 2.2 iOS (App Store)

| Rule (source)                                                                                                                                  | Repo today                                                                                                                                    | Gap / proposal                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.5.14: apps "must request explicit user consent and provide a clear visual and/or audible indication when recording" [P1]                     | Opt-in plus a per-recording notice (`apps/mobile/src/consent/ConsentSheet.tsx`); a banner while recording; Live Activity (`withLiveActivity`) | In line, assuming the device checklists pass (native code is still uncompiled, HANDOFF §6)                                                                    |
| 2.5.4: background services only "for their intended purposes: VoIP, audio playback, location, task completion, local notifications, etc." [P1] | `UIBackgroundModes: ["audio"]` for a user-started recording (`withRecordingCompliance.js` L28–L33)                                            | **Interpretation:** recording isn't named in the list, so the review notes in `docs/mobile/store-review.md` L8–L14 matter. Keep them; they already explain it |
| 5.1.1(i): privacy policy link in App Store Connect "and within the app in an easily accessible manner" [P1]                                    | Account screen has a "Recording privacy" card but no policy link (`apps/mobile/src/screens/AccountScreen.tsx` L85–L89)                        | **Gap** (F2)                                                                                                                                                  |
| 5.1.1(ii): an "easily accessible and understandable way to withdraw consent"; purpose strings must describe the use [P1]                       | `MICROPHONE_PURPOSE` in `apps/mobile/app.config.ts` L6–L7; per-recording consent; Stop on every screen                                        | **Proposal:** a "Withdraw recording opt-in" switch on the Account screen, so the R1 opt-in can be undone without reinstalling                                 |
| 5.1.1(v): "If your app supports account creation, you must also offer account deletion within the app" [P1]                                    | Signup exists; no deletion                                                                                                                    | **Gap** (F1)                                                                                                                                                  |
| Privacy manifest with required-reason APIs [P4, P5, P6]                                                                                        | None configured                                                                                                                               | **Gap** (F6). Collect reasons from each pod's `PrivacyInfo.xcprivacy` after prebuild, then set `ios.privacyManifests`                                         |
| Xcode 26 / iOS 26 SDK for uploads; minimum target iOS 13 [P5]                                                                                  | Expo 52                                                                                                                                       | **Not verified** whether Expo 52 builds on Xcode 26 (F4)                                                                                                      |

### 2.3 Android (Google Play)

| Rule (source)                                                                                                                                                                                                                                  | Repo today                                                                      | Gap / proposal                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microphone FGS: type `microphone`, permission `FOREGROUND_SERVICE_MICROPHONE`, and `RECORD_AUDIO` granted; RECORD_AUDIO is "subject to while-in-use restrictions", so the service can't be created while the app is in the background [P8, P9] | Declared in `withRecordingCompliance.js`; Start is a user tap in the foreground | In line. Device test: Start from the notification after the app is backgrounded must not be possible                                                                                      |
| Play Console FGS declaration: describe the feature, the impact if deferred or interrupted, and a video; the microphone video must "show the user initiate the microphone actively recording audio" [P10]                                       | Not filed (needs a Play account)                                                | **Owner + native** (F7). Draft text: user taps Record after the notice; deferral means no recording starts; interruption stops and saves the recording                                    |
| Prominent disclosure "immediately preceded" by an in-app disclosure; consent by "affirmative user action"; tapping away is not consent [P11]                                                                                                   | `ConsentSheet` mic step before the OS prompt                                    | **Interpretation:** a user-started recorder is within "reasonable expectation", so the strict form may not apply, but the sheet already meets it                                          |
| Account deletion "both in-app and on an external web resource", linked in Play Console; freezing is not deletion [P11]                                                                                                                         | None                                                                            | **Gap** (F1)                                                                                                                                                                              |
| Data safety section must "consistently match" the privacy policy [P11]                                                                                                                                                                         | Draft in `docs/mobile/store-review.md` L26–L30                                  | **Gap** (F9): fix the deletion claim, and add the AI sub-processors from [ai-provider-due-diligence.md](ai-provider-due-diligence.md) as "shared" or as service providers per Play's form |
| Target API 36 for new apps and updates since 31 Aug 2026 [P12]                                                                                                                                                                                 | Expo 52                                                                         | **Gap / not verified** (F3)                                                                                                                                                               |

### 2.4 Desktop (Tauri)

| Rule (source)                                                                                                                                                                 | Repo today                                                            | Gap / proposal                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| macOS: `NSMicrophoneUsageDescription` required for microphone APIs [P2]; Tauri merges `src-tauri/Info.plist` into the bundle and supports localised `InfoPlist.strings` [P17] | No `Info.plist`                                                       | **Gap** (F5). Add one with the same purpose text as mobile                                 |
| macOS: Audio Input entitlement under the Hardened Runtime [P3]; notarisation is required with a Developer ID certificate [P18]                                                | No entitlements file; release checklist §4 plans Developer ID signing | **Gap** (F5). Add `com.apple.security.device.audio-input` before the first notarised build |
| Windows microphone privacy settings                                                                                                                                           | —                                                                     | **Not researched** in this round                                                           |

### 2.5 Web

Browser `getUserMedia` prompts are handled by the browser; there is no store review. The only gap is F2 (privacy link
renders only when both env URLs are set) and the account-deletion page Play needs (F1).

## 3. Consent UX across clients (proposal)

The platform rules above and ADR-020 point the same way. One shared pattern would let each team build against the same
contract:

1. **Before capture:** the notice (versioned by `CURRENT_CONSENT_VERSION`, ADR-020 item 6) and an unticked confirmation
   on every client. The extension records `all_parties_consented` only (`apps/extension/src/lib/consent.ts`); mobile
   offers notice plus an optional "everyone agreed" tick. **Proposal:** decide one method per org setting (ADR-020 items
   2–3 and the "explicit consent on by default until an org country is stored" amendment in
   [PR #472](https://github.com/iakash22/meetops-platform/pull/472)) and have every client read it from the
   consent-settings API (#483–#485, open).
2. **During capture:** an always-visible indicator (ADR-020 item 2; Apple 2.5.14): banner and Live Activity on iOS, the
   ongoing notification on Android, the popup/side-panel state in the extension, and a window indicator on desktop.
3. **Withdraw:** Stop on every surface; `consent_revoked` stops capture (ADR-020 item 5); a way to undo the opt-in
   (Apple 5.1.1(ii)).
4. **Account deletion:** this collides with ADR-020's open GDPR erasure item (users who attested consent can't be
   hard-deleted, `docs/15-decisions/ADR-020-recording-consent.md` L48–L53). **Proposal for Architecture:** pseudonymise
   the `users` row and keep consent evidence, as ADR-020 already suggests, so a store-compliant "delete account" can
   ship. That is an ADR decision, not ours.

## 4. Build tasks this unblocks (proposals, not assigned)

| Team             | Task                                                                                                                                                      | From   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Architecture     | Settle ADR-020 erasure (pseudonymise vs. maintenance migration) so account deletion can ship                                                              | F1     |
| Backend          | Self-service account deletion route with the ADR-019 purge and a deletion receipt; org-owner edge cases (last owner)                                      | F1     |
| Frontend         | Web "Delete account" page (Play's external resource); privacy and terms links on every page once URLs exist                                               | F1, F2 |
| Native (mobile)  | In-app deletion and privacy link; `ios.privacyManifests`; check SDK 52 target and Xcode 26 in a prebuild; update `store-review.md`                        | F1–F7  |
| Native (desktop) | `src-tauri/Info.plist` with `NSMicrophoneUsageDescription`; macOS entitlements file with Audio Input                                                      | F5     |
| Extension        | Test whether the local user's voice is captured in Meet/Zoom/Teams web; if not, design an opt-in mic mix (new permission prompt, new consent text)        | F8     |
| AI               | If F8 holds, eval fixtures should include "host voice missing" cases so summaries don't credit commitments to the wrong person                            | F8     |
| Owner (Akash)    | Privacy policy and terms URLs; Play and Apple developer accounts; Expo/RN upgrade decision (HANDOFF §5.5) with F3–F4 as input; Chrome Web Store publisher | F2–F7  |

## 5. Not verified

- Whether Expo SDK 52 targets API 36 or builds with Xcode 26 (F3, F4).
- Whether Chrome shows a tab-capture indicator for extension `tabCapture` (§2.1).
- Whether tab capture misses the local user's voice in each meeting product (F8). This is an inference, not a test.
- Windows microphone privacy behaviour for the desktop app.
- Apple's Account deletion support page and Play's separate account-deletion help page could not be fetched (Google
  served a captcha); the requirements above come from the App Review Guidelines and Play's User Data policy page.

## Sources (checked 2026-11-18)

| ID  | Source                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Apple, App Review Guidelines (page "Last Updated: October 16, 2026"), 2.5.4, 2.5.14, 5.1.1: https://developer.apple.com/app-store/review/guidelines/                                                     |
| P2  | Apple, `NSMicrophoneUsageDescription`: https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription                                                  |
| P3  | Apple, Audio Input entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input                                                             |
| P4  | Apple, Privacy manifest files: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files                                                                                          |
| P5  | Apple, Upcoming requirements (SDK minimum since 28 Apr 2026; approved reasons since 1 May 2024; iOS 13 minimum since 9 Sep 2026): https://developer.apple.com/news/upcoming-requirements/                |
| P6  | Expo, Privacy manifests guide: https://docs.expo.dev/guides/apple-privacy/                                                                                                                               |
| P7  | Expo, SDK versions table (SDK 56–58 listed): https://docs.expo.dev/versions/latest/                                                                                                                      |
| P8  | Android Developers, Foreground service types (updated 2026-11-16 UTC): https://developer.android.com/develop/background-work/services/fgs/service-types                                                  |
| P9  | Android Developers, Restrictions on starting a foreground service from the background (updated 2026-11-16 UTC): https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start |
| P10 | Play Console Help, Understanding foreground service and full-screen intent requirements: https://support.google.com/googleplay/android-developer/answer/13392821                                         |
| P11 | Play Console Help, User Data policy: https://support.google.com/googleplay/android-developer/answer/10144311                                                                                             |
| P12 | Play Console Help, Target API level requirements: https://support.google.com/googleplay/android-developer/answer/11926878                                                                                |
| P13 | Chrome Web Store, Program Policies (updated 2025-05-22 UTC): https://developer.chrome.com/docs/webstore/program-policies/policies                                                                        |
| P14 | Chrome Web Store, Fill out the privacy fields (updated 2020-06-12 UTC): https://developer.chrome.com/docs/webstore/cws-dashboard-privacy                                                                 |
| P15 | Chrome Extensions, `chrome.tabCapture` (updated 2026-10-29 UTC): https://developer.chrome.com/docs/extensions/reference/api/tabCapture                                                                   |
| P16 | Chrome Extensions, `chrome.offscreen` (updated 2026-11-10 UTC): https://developer.chrome.com/docs/extensions/reference/api/offscreen                                                                     |
| P17 | Tauri, macOS Application Bundle (updated 21 Jul 2025): https://v2.tauri.app/distribute/macos-application-bundle/                                                                                         |
| P18 | Tauri, macOS Code Signing (updated 17 May 2026): https://v2.tauri.app/distribute/sign/macos/                                                                                                             |
| P19 | Chrome Web Store, Limited Use (updated 2022-11-01 UTC): https://developer.chrome.com/docs/webstore/program-policies/limited-use                                                                          |
