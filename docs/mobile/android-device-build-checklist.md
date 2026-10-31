# Android device build checklist (MeetOps mobile)

Use this for the first real-device build of `apps/mobile` on Android. None of the native Kotlin (#318
foreground service, #320 Keystore encryption) has been compiled or run yet. Record the result of each step (pass,
fail or notes, device model, Android version) in the PR or issue that tracks the device run.

## 1. Prerequisites

- [ ] macOS, Linux or Windows with Node `>=20.19 <25`, pnpm 9.12.3 (`corepack enable`), and `git`.
- [ ] JDK 17 (`java -version`), Android Studio (Ladybug or newer) with SDK Platform 35, Build-Tools 35,
      platform-tools (`adb`), and `ANDROID_HOME` set.
- [ ] One physical device on **Android 14 (API 34)**, plus ideally one on Android 13 and one on 10–12. Turn on USB
      debugging and check that `adb devices` lists it.
- [ ] A test account in a **live test organization** on an API reachable over HTTPS. Set `EXPO_PUBLIC_API_URL`
      to it; without it the app runs in demo mode and nothing reaches the server.
- [ ] Repo: `pnpm install --frozen-lockfile` at the root, then `pnpm --filter @meetops/mobile test` passes.
- [ ] Optional: Maestro CLI for `apps/mobile/e2e/record-consent.yaml`.

## 2. Identity and signing

- [ ] **Package id**: still the placeholder `com.example.meetops` (`app.config.ts`). The real id is pending with
      Akash. A debug/dev build with the placeholder is fine for device testing; never publish it.
- [ ] **Debug builds** use the auto-generated debug keystore. Nothing goes in the repo.
- [ ] **Release/preview builds**: the upload keystore lives in **EAS credentials** (`eas credentials -p android`)
      or a local keystore outside the repo. `*.jks`, `*.keystore`, `*.p12` and `*.key` are gitignored. Never
      commit or paste keystore passwords, and keep them out of `gradle.properties` in the repo.
- [ ] Run `gitleaks detect --redact` before pushing anything from the build machine.

## 3. Build

```bash
export COREPACK_HOME=/tmp/corepack
cd apps/mobile
# Generate the native project (applies withRecordingCompliance: permissions + microphone FGS).
npx expo prebuild --platform android --clean
# Note: prebuild rewrites the "android"/"ios" scripts in package.json; don't commit that change.

# Local dev-client build on a connected device (debug signing):
EXPO_PUBLIC_API_URL=https://<test-api-host> npx expo run:android --device

# Or a release APK locally (needs your release keystore configured outside the repo):
cd android && ./gradlew assembleRelease && cd ..

# Or EAS (credentials stay in EAS): development / preview profiles from eas.json
eas build -p android --profile development   # dev client, internal distribution
eas build -p android --profile preview       # internal APK/AAB
```

- [ ] `./gradlew` compiles `modules/recording-service` and `modules/chunk-crypto` with no Kotlin errors. Record any
      errors verbatim: this is their first compile.
- [ ] `android/app/src/main/AndroidManifest.xml` contains `RECORD_AUDIO`, `POST_NOTIFICATIONS`,
      `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, and the service
      `expo.modules.recordingservice.RecordingForegroundService` with `foregroundServiceType="microphone"` and
      `exported="false"`. Also check `allowBackup="false"` and that no `READ/WRITE_EXTERNAL_STORAGE` or
      `SYSTEM_ALERT_WINDOW` is present.

## 4. Install

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk   # local release build
# EAS: open the build page link / QR code on the device, or `eas build:run -p android --latest`
```

- [ ] Fresh install (uninstall first), so that first-run consent and permission prompts appear.

## 5. Manual test script

Run in order. After each recording, check the server (web app, the meeting's detail page) as well.

### A. Consent and permissions (R1, R3)

1. [ ] Sign in, open **Record**, tap Record. The opt-in consent appears before any OS prompt, never at launch.
2. [ ] Accept. The in-app mic pre-prompt appears, then the OS microphone dialog.
3. [ ] Android 13+: the notification permission is requested **before** recording starts. Deny it: recording
       doesn't start and a Settings link is shown, with no silent retry. Allow it from Settings and retry.
4. [ ] The participant notice appears before **every** recording. Cancel: nothing records.

### B. Recording and the foreground service (R2, R7)

5. [ ] Start. The persistent in-app banner shows on every tab. An ongoing notification "MeetOps is recording"
       with **Stop** and **Open** appears and can't be swiped away.
6. [ ] Background the app (Home) for 2+ minutes while speaking, then return. The recording kept running and the
       notification stayed.
7. [ ] Notification **Open** brings the app forward. Note whether it falls back to an empty intent (known Low #5).
8. [ ] Notification **Stop** ends capture immediately. The notification disappears, the banner clears, and the
       recording is queued for upload.
9. [ ] **Stop after swipe-away**: start recording, open Recents, swipe the app away. Capture must stop
       (`onTaskRemoved`): the notification goes away, and on relaunch nothing is recording. Note whether the
       partial recording was finalized or discarded (known Low #5: this depends on JS).
10. [ ] Phone call during recording (call the device). Recording **pauses** with a notice, and it doesn't resume
        until the user taps Resume.
11. [ ] Revoke the mic permission in Settings while recording. Capture stops and doesn't resume.
12. [ ] Start-failure race (known Medium #1): with notifications blocked for the app's channel, tap Record and
        check that no "recording" notification is left behind.
13. [ ] Force-stop the app (`adb shell am force-stop com.example.meetops`) mid-recording, then relaunch. No
        capture resumes, and leftover recorder files are swept.

### C. Encryption at rest and storage (R4, R5, R6)

14. [ ] After Stop, list the sandbox: `adb shell run-as com.example.meetops ls -R files/recordings` (debug
        build). There are only `*.chunk` files. Pull one (`run-as ... cat`) and check it's not playable or
        readable m4a: it should be high-entropy AES-GCM output.
15. [ ] While recording, the recorder's temporary file in the cache is plaintext (known R5 gap #3). Note its path
        and size, and confirm it's deleted after Stop.
16. [ ] A long recording (30+ min): note how long the encrypt-on-Stop takes and whether the UI stays responsive
        (known #4). Kill the app mid-encrypt and note the outcome.
17. [ ] `adb backup` / Auto Backup: confirm the app data isn't included (`allowBackup=false`).

### D. Notifications

18. [ ] Block the "recording" notification channel in system settings and try to record. The recording doesn't
        start, or the app pauses capture when backgrounded (the service is unconfirmed), and never records
        without a visible indicator.
19. [ ] Push/in-app notifications (if enabled for the test org): a processed-meeting notification arrives and opens
        the right meeting.

### E. Upload and verified deletion (R6)

20. [ ] Online: the recording uploads (`/orgs/:organizationId/recording-sessions` routes) and the server meeting
        moves to processing, then completed. The local chunk folder is deleted only after the server confirms
        the checksum.
21. [ ] Airplane mode at Stop: the item stays queued, and is retried with backoff on foreground or every 60 s in
        the foreground. Turn the network back on and it uploads.
22. [ ] Logout or switch organization with a queued item: local recordings are wiped and the encryption key is
        deleted.

### F. Mobile meeting source (PR #329)

23. [ ] After Start, the server meeting created by `POST /orgs/:organizationId/meetings/resolve` has
        **source `mobile`**. Check the web Meetings page ("Mobile app" label) or `GET /orgs/:id/meetings/:meetingId`.
24. [ ] Two recordings create two different meetings (a fresh `externalMeetingId` each time).
25. [ ] `GET /orgs/:id/meetings` lists them with `source: \"mobile\"`. The API doesn't apply the contracts `source`
        filter yet, so don't rely on `?source=mobile`.

### G. Maestro (optional)

26. [ ] `maestro test apps/mobile/e2e/record-consent.yaml` passes on the device.

## 6. Report

Include the device, OS version, build profile and commit SHA, each step's result, and any Kotlin compile errors or
logcat excerpts (`adb logcat | grep -i meetops`). Never put tokens, cookies or audio in the report.
