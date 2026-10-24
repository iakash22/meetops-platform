# MeetOps Mobile Plan (M1–M6)

Owner: Native Apps Agent. App: `apps/mobile` (Expo SDK 52, expo-router, strict TS).
Identity naming: `organizationId` everywhere.

## Milestones

| ID  | Scope                                                                                                                                                                                                      | Depends on            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M1  | Scaffold: Expo + expo-router + strict TS, app config with placeholder ids, eas.json (development/preview/production), Jest (jest-expo + RNTL) smoke test, lint/typecheck/test in CI (no EAS cloud builds). | none                  |
| M2  | Auth + session: sign-in, secure token storage (Keychain / Keystore via expo-secure-store), organization switcher, logout wipe hook.                                                                        | Backend auth contract |
| M3  | Consent + permissions: opt-in consent screen, participant-notice confirmation, consent API call (user, time, meeting, organizationId), mic permission prompts.                                             | Backend consent API   |
| M4  | Capture: dev-client build with native config: iOS background audio, Android microphone foreground service, persistent banner, Live Activity / Dynamic Island, interruption handling.                       | M3                    |
| M5  | Local storage + upload: encrypted sandbox storage, chunked TLS upload to pre-signed URLs, checksum confirmation, verified deletion, retention caps.                                                        | Media upload contract |
| M6  | Hardening + release: security review against R1–R7, store-review notes, privacy labels / Data safety, E2E on devices, EAS submit.                                                                          | Security, DevOps      |

## Platform configuration

### iOS background audio

- `UIBackgroundModes: ["audio"]` (via config plugin in M4), used **only** while a user-started recording is active.
- `NSMicrophoneUsageDescription`: plain-language purpose string ("MeetOps records meeting audio you choose to capture so it can be transcribed for your organization.").
- Audio session category `playAndRecord`, and observe `AVAudioSession.interruptionNotification` and route changes.
- Live Activity / Dynamic Island showing "Recording" with elapsed time and a Stop action (widget extension added in M4).

### Android microphone foreground service

- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `RECORD_AUDIO`, `POST_NOTIFICATIONS` (API 33+).
- Service declared with `android:foregroundServiceType="microphone"`. It starts only from a visible user action, as Android 14 requires.
- Ongoing, non-dismissible notification with **Stop** (ends capture immediately) and **Open** actions.

### Permission prompts

1. In-app pre-prompt that explains why the mic is needed, then the OS prompt. It's shown only when the user first taps Record, never at launch.
2. Android 13+: notification permission is requested before starting the foreground service. Without it, recording doesn't start.
3. Denied or revoked: show a settings deep link. The app never retries silently.

### Store-review notes

- Apple: describe the background audio use (user-initiated meeting capture only, with a visible indicator), provide a demo account, and explain consent and the participant notice. Privacy nutrition label: Audio Data, linked to the user, used for app functionality.
- Google Play: Foreground service declaration (microphone) with a demo video. Data safety: audio collected, encrypted in transit, deletable. Prominent disclosure before mic access.
- Use no background capture triggers, auto-start, or hidden recording paths.

## Security requirements (R1–R7)

1. **Explicit opt-in consent** before the first recording. Recording never starts silently.
2. **Visible indicators**: persistent in-app banner, the iOS mic indicator plus a Live Activity / Dynamic Island, and an Android microphone foreground service with a non-dismissible notification that has **Stop** and **Open**. Stop ends capture immediately.
3. **Participant notice** confirmation before each recording. Consent is logged with user, time, meeting and `organizationId` through the Backend consent API.
4. **Storage scope + retention**: audio stays only in the app sandbox and is excluded from backups (iOS `isExcludedFromBackup`, Android `allowBackup=false` / data-extraction rules). It's deleted within 24h of a confirmed upload. Local audio has a 7-day cap with a warning before deletion. Everything is wiped on logout or organization switch.
5. **Encryption**: iOS file protection `CompleteUntilFirstUserAuthentication` or stronger. Android uses AES-GCM with a Keystore-backed key. Uploads go over TLS only, to short-lived, org-scoped pre-signed URLs. Tokens never appear in URLs or logs.
6. **Verified deletion**: the local copy is deleted only after the server confirms the checksum, and then the deletion is verified (file absent, logged without content).
7. **Stop guarantees**: no recording after Stop, a crash, a permission revoke or logout. On relaunch, partial files are finalized or discarded and capture doesn't resume. A phone call interruption **pauses** recording with a notice, and the user has to resume it explicitly.

Each requirement gets automated tests (unit + device E2E) in M3–M6 and a sign-off from Security before M6.

## Needs from other agents

- **Arch**: package boundaries for mobile, and whether `@meetops/contracts` can be consumed from React Native (ESM/`dist`, TypeBox runtime size).
- **Backend**: the mobile auth flow (token type, refresh, organization switch) and the consent API (`POST` consent record with userId, meetingId, organizationId, timestamp).
- **Media**: the upload contract (chunking, checksum algorithm, pre-signed URL TTL/scope, server confirmation response).
- **DevOps**: CI runtime for jest-expo (first run is about 25s), cache for pnpm store, and later an EAS secrets setup outside the repo.
