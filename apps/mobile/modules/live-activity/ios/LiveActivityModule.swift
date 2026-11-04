import ExpoModulesCore
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// ActivityKit bridge for the recording indicator (plan.md R2: "Live Activity / Dynamic Island showing Recording
/// with elapsed time and a Stop action"). Local updates only: no push token is requested, so no APNs entitlement.
public class LiveActivityModule: Module {
  /// The activity is refreshed on every pause/resume; with no update for this long iOS shows it as stale (e.g. the
  /// app was killed without ending it) instead of a timer that looks live forever. Slightly over the 4 h contract
  /// recording cap (MAX_DURATION_MS), so a normal recording never goes stale.
  static let staleAfter: TimeInterval = 4 * 60 * 60 + 15 * 60

  static func staleDate() -> Date { Date().addingTimeInterval(staleAfter) }

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

    AsyncFunction("start") { (startedAtMs: Double) async -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      // One recording at a time: end anything left over first.
      await Self.endAll()
      let state = RecordingActivityAttributes.ContentState(
        isPaused: false, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000), elapsedSeconds: 0)
      do {
        _ = try Activity.request(
          attributes: RecordingActivityAttributes(),
          content: ActivityContent(state: state, staleDate: Self.staleDate()),
          pushType: nil)
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("update") { (paused: Bool, startedAtMs: Double, elapsedMs: Double) async in
      guard #available(iOS 16.2, *) else { return }
      let state = RecordingActivityAttributes.ContentState(
        isPaused: paused, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000),
        elapsedSeconds: elapsedMs / 1000)
      for activity in Activity<RecordingActivityAttributes>.activities {
        await activity.update(ActivityContent(state: state, staleDate: Self.staleDate()))
      }
    }

    AsyncFunction("end") { () async in
      guard #available(iOS 16.2, *) else { return }
      await Self.endAll()
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
