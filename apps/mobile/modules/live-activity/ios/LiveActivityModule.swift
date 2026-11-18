import ExpoModulesCore
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// ActivityKit bridge for the recording indicator (plan.md R2: "Live Activity / Dynamic Island showing Recording
/// with elapsed time and a Stop action"). Local updates only: no push token is requested, so no APNs entitlement.
///
/// `start` resolves with `Activity.id` so JS can pass it back to `update` / `end`. A refused or failed start
/// resolves `nil` (fail closed). `update` / `end` no-op when the id is empty or does not match a live activity.
public class LiveActivityModule: Module {
  /// The activity is refreshed on every pause/resume; with no update for this long iOS shows it as stale (e.g. the
  /// app was killed without ending it) instead of a timer that looks live forever. Slightly over the 4 h contract
  /// recording cap (MAX_DURATION_MS), so a normal recording never goes stale.
  static let staleAfter: TimeInterval = 4 * 60 * 60 + 15 * 60

  static func staleDate() -> Date { Date().addingTimeInterval(staleAfter) }

  /// Same rule as the JS side (src/record/liveActivity.ts isValidTimeMs): finite and not negative. A NaN, infinite
  /// or negative value must never reach the Date / interval conversion below.
  static func isValidTimeMs(_ v: Double) -> Bool { v.isFinite && v >= 0 }

  /// Non-empty ActivityKit id. Empty strings are fail-closed and never used to look up an activity.
  static func isActivityId(_ id: String) -> Bool { !id.isEmpty }

  private var stopObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("LiveActivity")
    Events("onStopRequested")

    OnStartObserving {
      self.stopObserver = NotificationCenter.default.addObserver(
        forName: meetOpsStopRecordingNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onStopRequested", [:])
      }
    }

    OnStopObserving {
      if let o = self.stopObserver { NotificationCenter.default.removeObserver(o) }
      self.stopObserver = nil
    }

    Function("areEnabled") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    AsyncFunction("start") { (startedAtMs: Double) async -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      guard Self.isValidTimeMs(startedAtMs) else { return nil }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
      // One recording at a time: end anything left over first.
      await Self.endAll()
      let state = RecordingActivityAttributes.ContentState(
        isPaused: false, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000), elapsedSeconds: 0)
      do {
        let activity = try Activity.request(
          attributes: RecordingActivityAttributes(),
          content: ActivityContent(state: state, staleDate: Self.staleDate()),
          pushType: nil)
        // Activity.id is the stable handle JS must pass to update/end.
        let id = activity.id
        return id.isEmpty ? nil : id
      } catch {
        return nil
      }
    }

    AsyncFunction("update") { (id: String, paused: Bool, startedAtMs: Double, elapsedMs: Double) async in
      guard #available(iOS 16.2, *) else { return }
      guard Self.isActivityId(id) else { return }
      guard Self.isValidTimeMs(startedAtMs), Self.isValidTimeMs(elapsedMs) else { return }
      let state = RecordingActivityAttributes.ContentState(
        isPaused: paused, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000),
        elapsedSeconds: elapsedMs / 1000)
      for activity in Activity<RecordingActivityAttributes>.activities where activity.id == id {
        await activity.update(ActivityContent(state: state, staleDate: Self.staleDate()))
      }
    }

    AsyncFunction("end") { (id: String) async in
      guard #available(iOS 16.2, *) else { return }
      guard Self.isActivityId(id) else { return }
      for activity in Activity<RecordingActivityAttributes>.activities where activity.id == id {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    AsyncFunction("endAll") { () async -> Int in
      guard #available(iOS 16.2, *) else { return 0 }
      return await Self.endAll()
    }
  }

  @available(iOS 16.2, *)
  @discardableResult
  private static func endAll() async -> Int {
    let all = Activity<RecordingActivityAttributes>.activities
    for activity in all {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    return all.count
  }
}
