# iOS Live Activity / Dynamic Island (recording indicator)

Plan reference: `docs/mobile/plan.md` (iOS background audio, R2). Status: **implemented, never compiled or run**.
The box has no Xcode or Swift toolchain, so this was only checked with Jest, TypeScript, lint and `expo prebuild`.

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
  and never stop or block a recording.

## Pieces

| Piece                                                                                                                                                   | Path                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Expo module (ActivityKit bridge, `start` / `update` / `end` / `endAll` / `onStopRequested`)                                                             | `apps/mobile/modules/live-activity/`                              |
| Shared `RecordingActivityAttributes` + `StopRecordingIntent` (two identical copies, guarded by a test)                                                  | `modules/live-activity/ios/` and `targets/RecordingLiveActivity/` |
| WidgetKit extension (lock screen + Dynamic Island UI)                                                                                                   | `apps/mobile/targets/RecordingLiveActivity/`                      |
| Config plugin: `NSSupportsLiveActivities`, copies the target, adds an embedded app-extension target (iOS 16.2, bundle id `<app>.RecordingLiveActivity`) | `apps/mobile/plugins/withLiveActivity.js`                         |
| JS state (elapsed time across pauses, best effort)                                                                                                      | `apps/mobile/src/record/liveActivity.ts`                          |
| Recorder wiring: start after `record()`, update on pause/resume, end on Stop/abort, `endAll` on launch recovery                                         | `src/record/nativeCapture.ts`, `src/services.ts`                  |

Entitlements: none. Updates are local only (no `pushType`, no APNs), and there's no
`NSSupportsLiveActivitiesFrequentUpdates`. No App Group is needed, because the widget reads only the
ActivityKit content state.

## Verified here

- `expo prebuild --platform ios --clean --no-install` succeeds. The generated project has `NSSupportsLiveActivities`
  in Info.plist, a `RecordingLiveActivity` app-extension target with the three Swift sources and the
  WidgetKit/SwiftUI/ActivityKit frameworks, a Copy Files (PlugIns, `dstSubfolderSpec 13`) phase plus a target
  dependency on the app, and no `undefined` values. Running it twice doesn't duplicate the target.
- Expo autolinking resolves `LiveActivity` / `LiveActivityModule` from `modules/live-activity`.
- Jest (`__tests__/live-activity.test.ts`) covers the state machine, best-effort failures, Stop gating, recorder
  wiring, plugin idempotency and build settings, and that the two attribute copies are identical.

## Not verified (needs a Mac + device)

1. **Swift compile** of the module and the widget (`xcodebuild` / EAS build). Watch for: `AsyncFunction` with
   `async` closures and `#available` guards in ExpoModulesCore 2.x, `ActivityContent` (16.2) vs the deployment
   target 15.1 of the app, and `Duration.formatted(.time(pattern:))`.
2. **App Intent discovery**: `StopRecordingIntent` is compiled into the `LiveActivity` pod (a static framework).
   If Xcode's App Intents metadata extraction doesn't pick it up from a pod, tapping Stop may do nothing in the app
   process. In that case, add `RecordingActivityAttributes.swift` to the main app target from the plugin as well.
3. Signing of the extension (automatic signing, same team, provisioning profile for
   `com.example.meetops.RecordingLiveActivity`) and EAS credentials for a second bundle id. The real bundle id is
   still pending with the owner.
4. Runtime: the activity appears on Start, the timer freezes on pause, Stop works on 17+, the link works on 16.x,
   and nothing is left behind after Stop, logout, a crash or a relaunch (`endAll`). See
   `docs/mobile/ios-device-build-checklist.md`.
