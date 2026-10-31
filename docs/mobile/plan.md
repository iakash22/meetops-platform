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

## Package boundaries (Architecture rule)

- Values may come only from `@meetops/contracts/types`. Anything from the `@meetops/contracts` root is `import type` only.
- Mobile must not depend on server packages (database, ai-core, integrations, queue), other apps, or deep `src/`/`dist/` paths.
- The contracts package is owned by Architecture, which will add a `default` export condition. Mobile doesn't modify it.

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

## Follow-ups

- **tar via @expo/cli (track):** Expo SDK 52's `@expo/cli` (and its `cacache`) pins `tar@6.2.1`, which has high and critical advisories (all fixed only in tar 7.x). It's used at build/CLI time only and never ships in the app bundle. For now the root `pnpm.overrides` pins `@expo/cli>tar` and `cacache>tar` to `^7.5.21`, and `bundle:check` passes with it. `@expo/cli@0.22.28` read tar through a default export, which tar 7 doesn't have, so `expo prebuild` failed with "Cannot read properties of undefined (reading 'extract')". `patches/@expo__cli@0.22.28.patch` (a pnpm patch) fixes the two call sites, and `expo prebuild --clean --no-install` now succeeds for Android and iOS. Remove the overrides and the patch once an Expo SDK upgrade ships a patched tar.
- **Auth callbacks:** prefer iOS Universal Links and Android App Links (verified domain) over the custom `meetops://` scheme for auth and deep-link callbacks, because any app can claim a custom scheme. Keep `meetops://` only for non-sensitive navigation.
- **Secure token storage (separate PR):** add `expo-secure-store` (~14.0.x for SDK 52, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) behind the existing `TokenStore` interface. It's out of the M2 auth shell PR because the lockfile is owned by another lane.
- **Real auth wiring:** `src/api/httpAuthClient.ts` implements `AuthClient` over HTTP and is used when `EXPO_PUBLIC_API_URL` is set (https only; loopback http in dev). Without it the app stays in demo mode. **Backend dependency:** the mobile token routes it targets (`POST /auth/mobile/token`, `/auth/mobile/refresh`, `/auth/mobile/logout`, Bearer on `GET /auth/session` and `POST /orgs/switch` returning `tokens`) are a proposal pending the ADR-005 mobile amendment. The token pair type in `src/auth/types.ts` stays a placeholder until contracts define it.
- **Contracts doc mismatch (Arch):** the contracts comment mentions `POST /auth/switch-org` returning `AuthSession`. The API implements `POST /orgs/switch` returning `{ organization, role }`, and mobile follows the API.
- **Meetings and tasks list APIs (Backend):** there are no list-meetings or list-tasks routes yet, so demo mode shows placeholder data. In live mode `src/data/httpRepositories.ts` calls `GET /orgs/:organizationId/tasks` (contracts `ListTasksQuery`) and `GET /orgs/:organizationId/meetings` (no list contract yet; assumed `CursorPage<Meeting>`).
- **Real recorder (M4):** done for live mode (see "M3/M4 status" below). Demo mode keeps the simulated capture.
- **Consent before recording (R1, R3):** done in the UI (M3). Start goes through opt-in (device-local), the mic pre-prompt or a Settings deep link after a denial, then the per-recording participant notice with an optional "everyone agreed" choice. The notice returns a contracts v0.4.1 `ConsentAttestationInput` (`CURRENT_CONSENT_VERSION`), which the upload queue attaches to `InitRecordingSessionRequest.consent` / `InitUploadRequest.consent`; contracts have no standalone consent route. Failures show as a toast and never start a recording. Live mode uses the real mic permission (expo-audio) plus the Android 13+ notification permission.
- **Offline upload queue (M5):** the queue engine is built (see M5 status below) and is what the Record tab uses. It still runs on an in-memory store and a simulated upload API; encrypted on-device storage and the HTTP upload API wait for the M4 recorder.
- **Theme sync:** mobile tokens match the web theme lane's final values (`docs/05-web/brand-theme.md`). Change both together.
- **Placeholder ids:** `com.example.meetops` / `meetops://` remain. The owner must choose the real bundle id/package and the verified domain for Universal/App Links.

### M3/M4 status (native recorder)

- `src/record/nativeCapture.ts`: expo-audio (~0.3.5, SDK 52) capture behind the `RecordingCapture` port (`src/record/capture.ts`), shared with the simulated capture. `begin` runs only from the participant-notice confirmation and refuses without permission; Stop ends capture, then `src/record/fileChunkStore.ts` splits the m4a into 4 MiB sha256-hashed chunk files in the app sandbox (`documentDirectory/recordings/<id>/`) and deletes the recorder output.
- `src/record/expoAudio.ts`: native mic permission (`createNativeMicPermission`, Android 13+ also `POST_NOTIFICATIONS`; a denial goes to Settings, never re-prompts), the expo-audio driver (audio session for recording only while a capture is active), and expo-file-system bindings. Loaded lazily; used only in live mode (`EXPO_PUBLIC_API_URL`), together with the HTTP recording-session upload API.
- R2: `RecordingBanner` on every signed-in screen while recording or paused (`src/record/indicator.ts`).
- R7: an interruption (call, Siri, another app taking the mic) is detected when the OS stops capturing; the tab pauses with a notice and only the user resumes. Logout / org switch run a wipe hook that aborts capture and wipes the queue; leaving the screen tree aborts capture; on launch, the recorder output of a capture interrupted by a crash or kill is deleted (`recoverOnLaunch`, via an in-progress marker) and nothing resumes.
- Config: `expo-audio` plugin with the plan's microphone purpose string; `plugins/withRecordingCompliance.js` adds iOS `UIBackgroundModes: ["audio"]` and Android `RECORD_AUDIO` + `POST_NOTIFICATIONS`.
- **NATIVE GAPS (need a native module and a device build; not done):** the Android microphone foreground service (`FOREGROUND_SERVICE_MICROPHONE`, `foregroundServiceType="microphone"`, Stop/Open notification) and the iOS Live Activity / Dynamic Island widget extension. Until the service exists, Android pauses capture whenever the app leaves the foreground (so it never records out of sight), and the manifest doesn't declare a foreground service. iOS keeps recording in the background with the system mic indicator. Neither was run on a device here (no EAS / simulator on the build box).

### M5 status (upload queue engine)

- `src/upload/uploadQueueEngine.ts`: durable queue over the recording-sessions contract: init with the G11 consent attestation, per-chunk signed URL, PUT with signed headers verbatim (https only, no cookies or bearer), complete with every chunk's size and sha256, then verified local deletion (R6). Exponential backoff (5 s to 15 min, 8 attempts), offline pause, resume from the last confirmed chunk, consent/validation rejections stop retrying, 7-day retention cap with a day-6 warning (R4), and `wipe()` for logout and org switch.
- Wiring (`src/services.ts`): the engine is the app's `uploadQueue` and `recordings.engine` in both demo and live mode. It runs on `createMemoryQueueStore()` (in memory, lost on restart), the simulated recorder as its `ChunkSource` (placeholder chunks, no audio), `createSimulatedUploadApi()` (nothing leaves the device) and an always-online network status. `createPlaceholderUploadQueue()` in `src/data/uploadQueue.ts` is now used only by test support (`__tests__/support/appRoutes.tsx`).
- `src/upload/httpRecordingUploadApi.ts` implements the same `RecordingUploadApi` over the recording-session routes with Bearer auth, and is covered by `__tests__/upload-queue.test.ts` and `__tests__/contract-paths.test.ts`, but nothing in the app uses it yet.
- Storage, chunk files and hashing sit behind ports (`QueueStore`, `ChunkSource`); native implementations (expo-file-system, expo-crypto) land with the M4 recorder and the lockfile slot.
- Dependencies: contracts `RecordingSource` now includes `'mobile'` (and `'desktop'`). The API serves recording-session routes (`apps/api/src/modules/media/http/recording-sessions.routes.ts`), but it has no mobile token routes (`/auth/mobile/*`) yet, so live uploads from mobile still wait on mobile Bearer auth (ADR-005 mobile amendment, draft PR #193).
