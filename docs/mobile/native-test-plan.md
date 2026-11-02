# Native mobile test plan (TS-6)

Written 1 Nov 2026 (IST) against `integration/phase-1` @ `e4aceac4`. Covers the native code that has **never been
compiled or run on a device**:

| PR   | Feature                                                                | Code                                                                                                                          |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #318 | Android microphone foreground service (FGS)                            | `modules/recording-service/android/.../RecordingForegroundService.kt`, `RecordingServiceModule.kt`                            |
| #320 | Encryption at rest: Android Keystore AES-GCM, iOS CryptoKit + Keychain | `modules/chunk-crypto/android/.../ChunkSealer.kt`, `ChunkCryptoModule.kt`; `modules/chunk-crypto/ios/ChunkCryptoModule.swift` |
| #321 | iOS backup exclusion and file protection                               | `modules/backup-exclusion/ios/BackupExclusionModule.swift`                                                                    |
| #331 | iOS Live Activity / Dynamic Island                                     | `modules/live-activity/ios/*`, `targets/RecordingLiveActivity/*`                                                              |
| #328 | Recorder hardening (pause on interruption, launch recovery, sweep)     | `src/record/*`, `src/services.ts`                                                                                             |
| #342 | Encrypted AAC segments (ADR-015)                                       | `modules/chunk-crypto/android/.../SegmentRecorderModule.kt`, `src/record/segmentCapture.ts`                                   |

Note: the native segment recorder exists only on **Android**. Check which capture path iOS uses
(`src/record/nativeCapture.ts`) and test it. Expect the R5 "plaintext in cache until Stop" gap to still apply on iOS.

The step-by-step device scripts are in [android-device-build-checklist.md](android-device-build-checklist.md) and
[ios-device-build-checklist.md](ios-device-build-checklist.md). This plan adds the matrix, test IDs, expected
results, evidence, and security checks. Never put tokens, cookies, keystore passwords or audio in evidence.

## 1. Build prerequisites

| Item            | Android                                                                            | iOS                                                                                                              | Blocked on                                                                                                |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Toolchain       | JDK 17, Android Studio Ladybug+, SDK 35, `adb`                                     | macOS + Xcode 16+, CocoaPods                                                                                     | A Mac for iOS (the box has neither SDK)                                                                   |
| JS              | Node >=20.19 <25, pnpm 9.12.3, `pnpm install --frozen-lockfile`, mobile jest green | same                                                                                                             | —                                                                                                         |
| Native project  | `npx expo prebuild -p android --clean`                                             | `npx expo prebuild -p ios --clean`                                                                               | —                                                                                                         |
| App id          | `com.example.meetops` placeholder (OK for debug only)                              | same                                                                                                             | **Maddy: real bundle id / package name**                                                                  |
| Accounts        | Google Play Console (internal testing)                                             | Apple Developer Program team, devices registered (`eas device:create`)                                           | **Maddy: Apple and Google accounts**                                                                      |
| Signing         | Debug keystore locally; release keystore in EAS credentials only                   | Development provisioning profile; Live Activity extension needs its own bundle id (`<id>.RecordingLiveActivity`) | **Maddy: EAS project and credentials**                                                                    |
| Backend         | HTTPS test API and a live test org (`EXPO_PUBLIC_API_URL`)                         | same                                                                                                             | Test environment and test account                                                                         |
| Expo/RN version | SDK 52 / RN 0.76                                                                   | same                                                                                                             | **Maddy: upgrade decision** (also RE-04). Test on the version that will ship, or retest after the upgrade |

## 2. Device matrix

| Platform | Must                                                        | Should                                                       | Nice                                                                 |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Android  | Pixel, Android 14 (API 34: FGS type `microphone` enforced)  | Android 15 (API 35); Android 13 (POST_NOTIFICATIONS runtime) | Android 10–12 Samsung (OEM battery killers); a device with StrongBox |
| iOS      | iPhone with Dynamic Island, iOS 17.x/18.x (App Intent Stop) | iOS 16.2–16.x (Live Activity, no intent)                     | iOS 15 (no Live Activity: graceful fallback)                         |

Run each case on every "Must" device and the relevant "Should" device.

## 3. Test cases

Evidence key: **SC** = screenshot or screen recording, **LOG** = `adb logcat` / Console.app excerpt filtered on MeetOps,
**CMD** = command output, **SRV** = web or API state. Store all evidence on the tracking issue.

### 3.0 Build (first compile)

| ID  | Step                                                             | Expected                                                                                                                                                                                         | Evidence                                       |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| B-1 | `./gradlew assembleDebug`                                        | recording-service and chunk-crypto compile, 0 Kotlin errors                                                                                                                                      | CMD (errors verbatim)                          |
| B-2 | Xcode build of the app and the `RecordingLiveActivity` extension | BackupExclusion, ChunkCrypto, LiveActivity pods compile; `.appex` is in `PlugIns/`                                                                                                               | CMD, SC                                        |
| B-3 | Inspect the merged AndroidManifest                               | RECORD_AUDIO, POST_NOTIFICATIONS, FOREGROUND_SERVICE(_MICROPHONE); service `exported=false`, `foregroundServiceType=microphone`; `allowBackup=false`; no external storage or SYSTEM_ALERT_WINDOW | CMD (`aapt dump xmltree` or the manifest file) |
| B-4 | Inspect Info.plist and entitlements                              | `NSMicrophoneUsageDescription`, `UIBackgroundModes=audio`, `NSSupportsLiveActivities=YES`; no APNs or App Group entitlements added by accident                                                   | CMD                                            |

### 3.1 Android foreground service (#318)

| ID    | Step                                                                 | Expected                                                                                                               | Evidence                                                                |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| FGS-1 | Start recording                                                      | An ongoing "MeetOps is recording" notification with Stop/Open appears **before** capture begins; it can't be dismissed | SC, `adb shell dumpsys activity services expo.modules.recordingservice` |
| FGS-2 | Background for 5 min, screen off                                     | Capture continues; the notification stays visible the whole time                                                       | SC, LOG, recording duration on the server                               |
| FGS-3 | Notification Stop                                                    | Capture stops in under 1 s, the notification is removed, the item is queued                                            | SC, LOG                                                                 |
| FGS-4 | Block the recording channel / deny POST_NOTIFICATIONS, then Record   | Recording does **not** start, or is paused when backgrounded. Never capture with no indicator                          | SC, LOG                                                                 |
| FGS-5 | Swipe away from Recents during recording                             | Capture stops (`onTaskRemoved`); nothing resumes on relaunch                                                           | LOG, `dumpsys` shows no service                                         |
| FGS-6 | Start-failure race (HANDOFF follow-up 1): make Start fail right away | No leftover "recording" notification                                                                                   | SC                                                                      |
| FGS-7 | `am force-stop` mid-recording, then relaunch                         | No auto-resume; leftover files are swept                                                                               | LOG, CMD (`run-as ls`)                                                  |
| FGS-8 | Incoming call, or revoke the mic permission                          | Pauses / stops; resumes only when the user taps                                                                        | SC                                                                      |

### 3.2 Encryption at rest (#320) and encrypted AAC segments (#342)

| ID    | Step                                                               | Expected                                                                                                                                     | Evidence         |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| ENC-1 | After Stop: `run-as <pkg> ls -R files/recordings`; pull a `.chunk` | Only `.chunk` files; high entropy (`ent` or `gzip` ratio ≈ 1); `ffprobe` fails                                                               | CMD              |
| ENC-2 | iOS: Download Container, inspect `Documents/recordings`            | Same as ENC-1 (AES-256-GCM)                                                                                                                  | CMD              |
| ENC-3 | Android, during recording: list the segment dir every 5 s          | At most one open `<seq>.part` (a few seconds of audio) in plaintext; sealed segments appear incrementally; `segments.txt` journal is present | CMD (timestamps) |
| ENC-4 | Kill the app mid-recording, relaunch                               | Recovery seals the leftover `.part` or securely deletes it; no plaintext remains; no sealed segment is lost; upload is complete with no gap  | CMD, SRV         |
| ENC-5 | Legacy plaintext re-seal: install the old build, record, upgrade   | Legacy files are re-sealed; the plaintext is deleted                                                                                         | CMD              |
| ENC-6 | 30+ min recording                                                  | Stop-to-queued time recorded; UI stays responsive (HANDOFF follow-up 4)                                                                      | SC, timing       |
| ENC-7 | Logout / switch org with a queued item                             | Local recordings are wiped **and** the key is deleted (a later decrypt of a pulled chunk fails)                                              | CMD, LOG         |
| ENC-8 | Server round trip                                                  | Server-side checksum matches; local chunks are deleted only after it is confirmed                                                            | SRV, LOG         |

### 3.3 iOS backup exclusion and file protection (#321)

| ID   | Step                                                                                                               | Expected                                                                         | Evidence |
| ---- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------- |
| BK-1 | Record, then make an encrypted Finder backup; inspect with a backup browser (e.g. iMazing, read-only)              | No `Documents/recordings` files in the backup                                    | SC, CMD  |
| BK-2 | Settings > Apple ID > iCloud > Manage Storage > Backups > device                                                   | MeetOps backup size does not grow with recordings                                | SC       |
| BK-3 | Reboot, don't unlock, try to read the container (Xcode/devicectl)                                                  | Files can't be read before first unlock (`CompleteUntilFirstUserAuthentication`) | CMD      |
| BK-4 | Make the exclusion fail (e.g. a read-only dir in a debug build)                                                    | Recording fails closed, with no unprotected file                                 | LOG      |
| BK-A | Android: `adb backup -f mo.ab com.example.meetops` (API ≤ 30), or `bmgr backupnow` with `adb shell dumpsys backup` | No app data in the backup (`allowBackup=false`)                                  | CMD      |

### 3.4 iOS Live Activity (#331)

| ID   | Step                               | Expected                                                                          | Evidence   |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| LA-1 | Start                              | Lock screen and Dynamic Island show recording, a timer, and Stop                  | SC         |
| LA-2 | Inspect content                    | No meeting title, org, participant, or ids                                        | SC         |
| LA-3 | Pause / Resume                     | "Paused" shown with the timer frozen; resume continues from the same elapsed time | SC (video) |
| LA-4 | iOS 17+: Stop from the lock screen | Capture stops; the activity ends; the item is queued                              | SC, LOG    |
| LA-5 | iOS 16.2: Stop                     | Opens the app on Record                                                           | SC         |
| LA-6 | iOS 15, or Live Activities off     | Recording works with no error                                                     | SC         |
| LA-7 | Swipe away, relaunch               | `endAll` removes any stale activity; note how long it stayed before relaunch      | SC         |

### 3.5 Recorder hardening (#328)

| ID   | Step                                                                          | Expected                                                                                             | Evidence |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| RH-1 | Consent order on fresh install                                                | Consent, then pre-prompt, then OS prompt; never at launch; participant notice before every recording | SC       |
| RH-2 | Siri / call / route change (Bluetooth on and off)                             | Pause plus notice; manual resume only                                                                | SC       |
| RH-3 | Launch sweep (HANDOFF follow-up 2): start recording right after a cold launch | The sweep never deletes a live file; it only touches `Audio/` / `ExpoAudio/`                         | LOG, CMD |
| RH-4 | Airplane mode at Stop                                                         | Queued, retried with backoff, uploads once back online                                               | SRV      |

## 4. Security checks (pass/fail gates for store submission)

1. **The key never leaves the hardware keystore.**
   - Android: the key alias is created with `KeyGenParameterSpec` in `AndroidKeyStore`. Check `KeyInfo.isInsideSecureHardware`
     (or `securityLevel` ≥ TRUSTED_ENVIRONMENT on API 31+) in a debug log line. The key can't be exported:
     `getEncoded()` returns null. There are no key bytes in SharedPreferences or files (`run-as` grep).
   - iOS: the key is stored in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (this-device-only:
     never synced, never in backups). It is a CryptoKit `SymmetricKey`, so it is in the Keychain, **not** the Secure
     Enclave. Record this accurately: the Secure Enclave holds only P-256 keys. Restore a backup to another device:
     old chunks can't be decrypted.
   - No key material, IV, or plaintext appears in logcat or Console (grep for base64 runs longer than 32 characters).
2. **No plaintext left on disk.** After Stop, after a kill and recovery, and after logout, a recursive listing of the
   cache, files, tmp, and Documents shows no `.m4a`, `.aac`, `.part` or `.caf` files (ENC-3/4, RH-3). Known gap: on the
   expo-audio path, the whole recording is plaintext in the cache until Stop (HANDOFF follow-up 3). Record whether
   #342 closes it on Android, and whether it is still open on iOS.
3. **Backup exclusion is verified**, not assumed: BK-1, BK-2, BK-A.
4. **No covert recording.** On Android, capture happens only while the FGS notification is visible (FGS-1/2/4/5).
   On iOS, the orange mic indicator is always shown, and the Live Activity is shown when enabled. Recording never
   starts without consent and the participant notice.
5. **Least privilege.** No extra permissions or entitlements (B-3, B-4). The service is not exported. No deep link
   starts recording.

## 5. HANDOFF mobile follow-ups to re-verify

| #   | Follow-up (HANDOFF "Open mobile follow-ups")                                             | Test                      |
| --- | ---------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Start-failure race leaves a "recording" notification (`RecordingServiceModule.kt:36-40`) | FGS-6                     |
| 2   | Launch cache sweep isn't awaited and could delete a live `.m4a`                          | RH-3                      |
| 3   | R5: plaintext in the cache until Stop (#342 aims to fix this on Android)                 | ENC-3, security check 2   |
| 4   | Encryption on the JS thread is slow; a kill mid-encrypt deletes the recording            | ENC-4, ENC-6              |
| 5   | Stop after swipe-away depends on JS; Open falls back to an empty Intent                  | FGS-5, checklist A step 7 |
| —   | Still open on Maddy: real bundle id, Expo/RN upgrade, EAS credentials                    | §1                        |

## 6. Exit criteria

All "Must" devices pass §3.0–§3.4 and all five §4 checks, with evidence attached. Any security-check failure blocks
store submission. Known gaps that remain open need an entry in `docs/12-security/risk-exceptions.md` or a fix.
