// Compiled into BOTH the app target and the widget extension by plugins/withLiveActivity.js (Apple requires a
// LiveActivityIntent to be a member of the app target so its App Intents metadata is extracted there and
// `perform()` runs in the app process). It is deliberately NOT in the LiveActivity pod: App Intents metadata is
// not reliably extracted from static pod libraries.
import Foundation

/// File-private copy of `meetOpsStopRecordingNotification` (RecordingActivityAttributes.swift), so this file
/// compiles the same way in the app target and the widget extension without depending on the LiveActivity pod
/// module. __tests__/live-activity.test.ts asserts both spellings stay identical.
fileprivate let stopRecordingIntentNotification = Notification.Name("MeetOpsLiveActivityStopRecording")

#if canImport(AppIntents) && canImport(ActivityKit)
import AppIntents

/// Stop button on the Live Activity / Dynamic Island (iOS 17+). Runs in the app process (woken if needed) and posts
/// the notification the LiveActivity module turns into `onStopRequested`, which ends capture like the in-app Stop.
/// Posts `stopRecordingIntentNotification`, the file-private copy of `meetOpsStopRecordingNotification`.
@available(iOS 17.0, *)
struct StopRecordingIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop recording"
  static var openAppWhenRun: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(name: stopRecordingIntentNotification, object: nil)
    return .result()
  }
}
#endif
