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

/// Posted in the app process when the Live Activity Stop button runs `StopRecordingIntent`
/// (targets/RecordingLiveActivity/StopRecordingIntent.swift, compiled into the app and the widget extension).
public let meetOpsStopRecordingNotification = Notification.Name("MeetOpsLiveActivityStopRecording")
