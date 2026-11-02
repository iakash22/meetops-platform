// KEEP IN SYNC: this file is duplicated byte-for-byte in modules/live-activity/ios/ (app target) and
// targets/RecordingLiveActivity/ (widget extension). ActivityKit matches the two by type name and Codable shape.
// __tests__/live-activity.test.ts fails if the copies differ.
import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.1, *)
public struct RecordingActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// Paused by the user or by a call; the widget freezes the elapsed time and says "Paused".
    public var isPaused: Bool
    /// Effective start (already shifted by paused time), so a running timer is `Text(timerInterval:)` from here.
    public var startedAt: Date
    /// Elapsed seconds shown while paused.
    public var elapsedSeconds: Double

    public init(isPaused: Bool, startedAt: Date, elapsedSeconds: Double) {
      self.isPaused = isPaused
      self.startedAt = startedAt
      self.elapsedSeconds = elapsedSeconds
    }
  }

  /// No meeting title or ids on the lock screen: the activity only says that MeetOps is recording.
  public init() {}
}
#endif

/// Posted in the app process when the Live Activity Stop button runs `StopRecordingIntent`.
public let meetOpsStopRecordingNotification = Notification.Name("MeetOpsLiveActivityStopRecording")

#if canImport(AppIntents) && canImport(ActivityKit)
import AppIntents

/// Stop button. As a `LiveActivityIntent` it runs in the app's process (iOS 17+), which is woken if needed; the
/// module turns the notification into the JS `onStopRequested` event, which ends capture like the in-app Stop.
@available(iOS 17.0, *)
public struct StopRecordingIntent: LiveActivityIntent {
  public static var title: LocalizedStringResource = "Stop recording"
  public static var openAppWhenRun: Bool = false

  public init() {}

  public func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(name: meetOpsStopRecordingNotification, object: nil)
    return .result()
  }
}
#endif
