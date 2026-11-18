# iOS Live Activity / Dynamic Island (recording indicator)

Plan reference: `docs/mobile/plan.md` (iOS background audio, R2). Status: **implemented, never compiled or
run**. The box has no Xcode or Swift toolchain, so this was only checked with Jest, TypeScript, lint and
`expo prebuild`. The Swift change that returns `Activity.id` from `start` is in the repo but **cannot be
compiled here**.

## Activity id contract

Native `start` must return a stable activity id, and callers must store it and pass it to `update` / `end`.

| Side                                                                               | `start` returns                                                       | `update` / `end` (or Android `stop`)                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| iOS ActivityKit (`LiveActivityModule.swift`)                                       | `activity.id` (string), or `nil` if refused / invalid time / pre-16.2 | only the activity whose `id` matches; unknown or empty ids are a no-op            |
| JS port (`src/record/liveActivity.ts`, `modules/live-activity`)                    | `Promise<string \| null>`                                             | stored id; a null or empty start is fail-closed (no update/end)                   |
| Android foreground service (`RecordingServiceModule.kt`, #318 handshake unchanged) | decimal string of the existing `captureId` from `beginStart()`        | `matchesSession(id)` must pass; a stale or empty id does not cancel a newer start |

A late iOS `start` that resolves after it was superseded is ended **by that id only**. It must not call
`endAll()`, which would tear down a newer recording's activity. `endAll()` remains the launch-recovery path
for leftovers after a crash or kill.

## What it does

- While a live-mode recording runs on iOS 16.2+, the lock screen and the Dynamic Island show "MeetOps is
  recording" (or "Paused") with the elapsed time, plus a **Stop** button.
- It doesn't show a meeting title, ids, organization or participants. The attributes carry no data, and the
  content state is only `isPaused`, `startedAt` and `elapsedSeconds`.
- Stop: on iOS 17+ the button runs `StopRecordingIntent` (a `LiveActivityIntent`, in the app process). The intent
  posts a notification, the module emits `onStopRequested`, and the recorder treats it like the Android
  notification Stop. On iOS 16.x the button is a `meetops://record` link that opens the Record tab, where the user
  taps Stop.
- Best effort: if the user turned off Live Activities, or the system refuses, capture still runs with the system
  mic indicator and the in-app banner. This is the same R2 coverage the app had before. Failures are swallowed
  and never stop or block a recording. Android is stricter: if the foreground service cannot start (no id),
  capture does not begin.

## Pieces

| Piece                                                                                                                                                   | Path                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Expo module (ActivityKit bridge, `start` returns `activity.id`, `update`/`end` take it, `endAll`, `onStopRequested`)                                    | `apps/mobile/modules/live-activity/`                                         |
| Shared `RecordingActivityAttributes` + `StopRecordingIntent` (two identical copies, guarded by a test)                                                  | `modules/live-activity/ios/` and `targets/RecordingLiveActivity/`            |
| WidgetKit extension (lock screen + Dynamic Island UI)                                                                                                   | `apps/mobile/targets/RecordingLiveActivity/`                                 |
| Config plugin: `NSSupportsLiveActivities`, copies the target, adds an embedded app-extension target (iOS 16.2, bundle id `<app>.RecordingLiveActivity`) | `apps/mobile/plugins/withLiveActivity.js`                                    |
| JS state (elapsed time across pauses, stores the native id, best effort)                                                                                | `apps/mobile/src/record/liveActivity.ts`                                     |
| Recorder wiring: start after `record()`, update on pause/resume, end on Stop/abort, `endAll` on launch recovery                                         | `src/record/nativeCapture.ts`, `src/services.ts`                             |
| Android equivalent: microphone foreground service returns `captureId` from `start` for `update`/`stop`                                                  | `apps/mobile/modules/recording-service/`, `src/record/recordingIndicator.ts` |

Entitlements: none. Updates are local only (no `pushType`, no APNs), and there's no
`NSSupportsLiveActivitiesFrequentUpdates`. No App Group is needed, because the widget reads only the
ActivityKit content state. Do not add an App Group unless a future change starts sharing files or defaults
between the app and the extension.

## Xcode / prebuild steps (cannot be done on this Linux box)

These need a Mac with Xcode (see also `docs/mobile/ios-device-build-checklist.md`).

1. **Config plugin / prebuild.** From `apps/mobile`, run
   `npx expo prebuild --platform ios --clean` (pod install runs on macOS). The plugin must:
   - set `NSSupportsLiveActivities` = `YES` in the **app** `Info.plist`;
   - copy `targets/RecordingLiveActivity/` into the generated `ios/` tree;
   - add an embedded app-extension target `RecordingLiveActivity` (bundle id
     `<app-id>.RecordingLiveActivity`, iOS 16.2+, WidgetKit / SwiftUI / ActivityKit);
   - add a Copy Files (PlugIns, `dstSubfolderSpec 13`) phase and a target dependency on the app;
   - compile `StopRecordingIntent.swift` into the **app** target as well as the widget, so App Intents
     metadata is extracted from the app (`findAppTarget` matches product type `application` and the
     project name — prebuild must fail if that target is missing).
     Confirm a second prebuild does not duplicate the target. Do not commit prebuild-rewritten
     `package.json` scripts or the generated `ios/` tree unless the repo already tracks them.
2. **Widget extension target** in `ios/MeetOps.xcworkspace`: the extension's Info.plist
   (`targets/RecordingLiveActivity/Info.plist`, copied by the plugin) and its three Swift sources plus
   `Info.plist` are present. The built `.app` must contain `PlugIns/RecordingLiveActivity.appex`.
3. **`NSSupportsLiveActivities`.** App Info.plist must have `NSSupportsLiveActivities` = `YES`. The
   widget plist does not need this key; it is an app capability. There is no
   `NSSupportsLiveActivitiesFrequentUpdates`.
4. **Entitlements.** None are required for this feature (local ActivityKit updates, `pushType: nil`).
   Check `ios/MeetOps/MeetOps.entitlements` (if present) and the extension entitlements: no APNs /
   `aps-environment` and no App Group were added by accident.
5. **App Group.** Not used. Skip creating one unless a later change needs shared containers. If one is
   added, both the app and the extension must share the same group and it must be in both entitlements.
6. **Signing.** Automatic signing, same team, for **both** the app and
   `<id>.RecordingLiveActivity`. The real bundle id is still the placeholder `com.example.meetops`
   pending Akash. EAS: `eas credentials -p ios` must cover the second bundle id.
7. **Compile.** `xcodebuild` / `expo run:ios` / EAS must compile `LiveActivityModule.swift` (start
   now returns `String?` / `activity.id`), the widget, and the intent. Watch for: `AsyncFunction` with
   `async` closures and `#available` in ExpoModulesCore 2.x; `ActivityContent` (16.2) vs app deployment
   target 15.1; `Duration.formatted(.time(pattern:))`; `import LiveActivity` is not used by the intent
   (file-private notification-name copy). This box cannot run that compile.

## Device test checklist

Use a physical iPhone (Live Activities are limited on Simulator). Full script:
`docs/mobile/ios-device-build-checklist.md`. Minimum for the id contract:

- [ ] Settings > MeetOps > Live Activities is on.
- [ ] Start a recording on iOS 16.2+: the lock screen / Dynamic Island shows "MeetOps is recording"
      with elapsed time, and no meeting title or ids.
- [ ] Pause freezes the timer ("Paused"); resume continues from the same elapsed time (the same
      activity id was updated, not a new activity).
- [ ] Stop (in-app, and the Live Activity Stop button on iOS 17+) dismisses **that** activity
      immediately; nothing is left on the lock screen.
- [ ] Fast Start then Stop does not leave an orphan. Kill the app mid-recording, relaunch:
      `endAll()` clears leftovers; capture does not resume.
- [ ] A user who disabled Live Activities can still record (system mic indicator + in-app banner).
- [ ] iOS 16.2–16.x: Stop is a `meetops://record` link; the in-app Stop still works.
- [ ] iOS 15.x: no Live Activity; recording still works.

## Verified here (Linux box)

- Jest (`__tests__/live-activity.test.ts`, `__tests__/recording-indicator.test.ts`): state machine,
  id contract (start returns id, update/end use it, null/empty start fails closed, late start ends
  only that id), best-effort failures, Stop gating, recorder wiring, plugin idempotency, source
  assertions for `activity.id` and the Android `captureId`.
- Typecheck and lint of `@meetops/mobile`.
- Earlier: `expo prebuild --platform ios --clean --no-install` succeeded (plugin wiring). Not re-run
  for the id-return change; prebuild does not compile Swift.

## Not verified (needs a Mac + device)

Swift compile, podspec install, App Intent discovery on device, signing of the extension, and all
runtime behaviour in the checklist above. Android Kotlin for the session id was also reviewed
statically only (no Android SDK / Gradle on this pass).
