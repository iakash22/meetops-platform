// Compiled into BOTH the app target and the widget extension by plugins/withLiveActivity.js (Apple requires a
// LiveActivityIntent to be a member of the app target so its App Intents metadata is extracted there and
// `perform()` runs in the app process). It is deliberately NOT in the LiveActivity pod: App Intents metadata is
// not reliably extracted from static pod libraries.
import Foundation

#if canImport(AppIntents) && canImport(ActivityKit)
import AppIntents

/// Stop button on the Live Activity / Dynamic Island (iOS 17+). Runs in the app process (woken if needed) and posts
/// the notification the LiveActivity module turns into `onStopRequested`, which ends capture like the in-app Stop.
/// The notification name string must match `meetOpsStopRecordingNotification` in RecordingActivityAttributes.swift.
@available(iOS 17.0, *)
struct StopRecordingIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop recording"
  static var openAppWhenRun: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(
      name: Notification.Name("MeetOpsLiveActivityStopRecording"), object: nil)
    return .result()
  }
}
#endif
