# iOS device build checklist (MeetOps mobile)

Use this for the first real-device build of `apps/mobile` on iOS. None of the native Swift (#320 CryptoKit +
Keychain, #321 backup exclusion and file protection, #331 Live Activity) has been compiled or run yet. Record each
step's result (pass, fail or notes, device, iOS version) in the tracking PR or issue.

## 1. Prerequisites

- [ ] A Mac with **Xcode 16** (or newer) and its command line tools, CocoaPods (`pod --version`), Node
      `^20.19 || >=22.12 <25`, and pnpm 9.12.3 (`corepack enable`).
- [ ] Devices: one iPhone with **Dynamic Island on iOS 17+**, plus ideally one on iOS 16.2–16.x (Live Activity
      Stop falls back to a link there) and one on iOS 15.x (no Live Activity; recording must still work).
- [ ] An Apple Developer account (team) that can register the app id and its extension id.
- [ ] A test account in a **live test organization** on an HTTPS API, with `EXPO_PUBLIC_API_URL` set to it. Without
      it the app runs in demo mode.
- [ ] `pnpm install --frozen-lockfile` at the root, and `pnpm --filter @meetops/mobile test` passes.
- [ ] Optional: Maestro for `apps/mobile/e2e/record-consent.yaml`.

## 2. Identity, signing and entitlements

- [ ] **Bundle id**: still the placeholder `com.example.meetops`. The real id is pending with Akash. For device
      testing, set a team-unique id locally (don't commit it), or use EAS with the placeholder replaced.
- [ ] Two bundle ids need provisioning: the app `<id>` and the Live Activity extension `<id>.RecordingLiveActivity`
      (added by `plugins/withLiveActivity.js`).
- [ ] Xcode: open `ios/MeetOps.xcworkspace`, and for **both** targets (MeetOps, RecordingLiveActivity) choose your
      Team with Automatic signing. EAS: `eas credentials -p ios` creates profiles for both. Certificates and
      profiles stay in the keychain or EAS, never in the repo (`*.p12`, `*.p8` and `*.mobileprovision` are gitignored).
- [ ] Entitlements: **none** are needed for the Live Activity (local updates only, no push). Keychain access uses the
      default access group. Check that `ios/MeetOps/MeetOps.entitlements` (if present) has no APNs or App Group
      entries added by accident.
- [ ] Info.plist: `NSMicrophoneUsageDescription` (the plan's purpose string), `UIBackgroundModes` = `audio`, and
      `NSSupportsLiveActivities` = YES.

## 3. Build

```bash
export COREPACK_HOME=/tmp/corepack
cd apps/mobile
npx expo prebuild --platform ios --clean        # runs pod install on macOS
# prebuild rewrites the "ios"/"android" scripts in package.json; don't commit that change.

# Dev-client build on a connected device:
EXPO_PUBLIC_API_URL=https://<test-api-host> npx expo run:ios --device

# Or Xcode: open ios/MeetOps.xcworkspace, select the device, Product > Run (scheme MeetOps).
# Or an archive from the CLI:
xcodebuild -workspace ios/MeetOps.xcworkspace -scheme MeetOps -configuration Release \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates archive -archivePath build/MeetOps.xcarchive

# Or EAS (credentials stay in EAS):
eas build -p ios --profile development
eas build -p ios --profile preview
```

- [ ] The build compiles `BackupExclusion`, `ChunkCrypto`, `LiveActivity` (pods) and the `RecordingLiveActivity`
      extension. Record any Swift errors verbatim: this is their first compile. Watch for: `AsyncFunction`
      async closures, `ActivityContent` availability (16.2), `Duration.formatted`, and `Button(intent:)` (17).
- [ ] The built `.app` contains `PlugIns/RecordingLiveActivity.appex`.

## 4. Install

- [ ] `npx expo run:ios --device` installs directly. EAS internal builds install from the build page or QR code
      (register the device UDID first, `eas device:create`). For Xcode archives, use Organizer > Distribute >
      Development/Ad Hoc.
- [ ] Fresh install (delete the app first), so the consent and permission prompts appear.
- [ ] Settings > MeetOps > Live Activities is **on**, for the Live Activity tests.
- [ ] Activity id: pause/resume must update the **same** Live Activity (not spawn a second one), and
      Stop must dismiss that activity only. A fast Start then Stop must not leave an orphan. See
      `docs/mobile/live-activity.md` (activity id contract and Xcode steps).

## 5. Manual test script

### A. Consent and permissions (R1, R3)

1. [ ] Record tab > Record: opt-in consent, then the mic pre-prompt, then the OS mic alert, in that order and
       never at launch. Deny: a Settings link is shown, with no silent retry.
2. [ ] The participant notice appears before every recording. Cancel: nothing records.

### B. Recording, background audio and the indicators (R2, R7)

3. [ ] Start: the in-app banner shows on all tabs, and the orange mic indicator / status bar pill shows.
4. [ ] Lock the device and speak for 2+ minutes. Recording continues (background audio).
5. [ ] Phone call or Siri mid-recording: recording **pauses** with a notice and resumes only when the user taps
       Resume.
6. [ ] **Stop after swipe-away**: start recording, swipe the app away in the App Switcher. On relaunch nothing is
       recording, no capture resumes, and the partial file is discarded or finalized (note which). The Live
       Activity must be gone after the relaunch (`endAll` in launch recovery). Note whether it stays on the lock
       screen until relaunch.
7. [ ] Logout while recording: capture stops, local audio is wiped, and the Live Activity ends.

### C. Live Activity / Dynamic Island (PR #331)

8. [ ] On Start, the lock screen shows "MeetOps is recording" with a running timer and a **Stop** button. The
       Dynamic Island shows a compact recording dot and timer; long-press shows the expanded view with Stop.
9. [ ] There's no meeting title, organization, participant or other id anywhere on the activity.
10. [ ] Pause in the app: the activity shows "Paused" with the timer frozen. Resume: the timer continues from the
        same elapsed value (paused time isn't counted).
11. [ ] **iOS 17+**: tap Stop on the lock screen without unlocking the app UI. Capture stops (the in-app banner
        clears on return, and the recording is queued) and the activity disappears. If nothing happens, App
        Intent discovery from the pod failed (see `docs/mobile/live-activity.md`, unverified #2).
12. [ ] **iOS 16.2–16.x**: Stop opens the app on the Record tab, then tap Stop in the app.
13. [ ] **iOS 15** or Live Activities turned off: recording still works with the mic indicator and banner, and no
        error is shown.
14. [ ] In-app Stop: the activity disappears immediately.

### D. Encryption, file protection and backup (R4, R5, R6)

15. [ ] Xcode > Devices > MeetOps > Download Container. `Documents/recordings/<id>/*.chunk` files are not playable
        or readable m4a (AES-256-GCM).
16. [ ] During recording, the recorder's temporary file in the cache is plaintext (known R5 gap #3). Confirm it's
        deleted after Stop.
17. [ ] File protection: with the device locked right after a reboot (before the first unlock), recordings aren't
        readable (`CompleteUntilFirstUserAuthentication`). Backup: a Finder/iCloud backup doesn't include
        `Documents/recordings` (`isExcludedFromBackup`).
18. [ ] Long recording (30+ min): note the Stop-to-queued time (JS-thread encryption, known #4).

### E. Notifications

19. [ ] If push or in-app notifications are enabled for the test org: a processed-meeting notification arrives and
        opens the right meeting. Recording itself needs no notification permission on iOS.

### F. Upload and verified deletion (R6)

20. [ ] Online: the upload completes and the server meeting goes to processing, then completed. The local chunks
        are deleted only after the server confirms the checksum.
21. [ ] Airplane mode at Stop: the item stays queued and is retried on foreground. Once back online, it uploads.

### G. Mobile meeting source (PR #329)

22. [ ] The server meeting for each recording has **source `mobile`** (web Meetings "Mobile app" label, or
        `GET /orgs/:id/meetings/:meetingId`), and each recording gets its own meeting.
23. [ ] `GET /orgs/:id/meetings` lists them with `source: \"mobile\"`. The API doesn't apply the contracts `source`
        filter yet, so don't rely on `?source=mobile`.

### H. Maestro (optional)

24. [ ] `maestro test apps/mobile/e2e/record-consent.yaml` passes (set `appId` to your local bundle id if you changed
        it, and don't commit that change).

## 6. Report

Include the device, iOS version, build profile, commit SHA, each step's result, and Swift compile errors or
Console.app excerpts filtered on MeetOps. Never include tokens, cookies or audio.
