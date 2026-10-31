import ActivityKit
import SwiftUI
import WidgetKit

/// Lock screen banner + Dynamic Island for an in-progress MeetOps recording (R2). Shows only "Recording" or
/// "Paused" and the elapsed time: no meeting title, participants or organization on the lock screen.
@available(iOS 16.2, *)
struct RecordingLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
      HStack(spacing: 12) {
        StatusDot(paused: context.state.isPaused)
        VStack(alignment: .leading, spacing: 2) {
          Text(context.state.isPaused ? "MeetOps recording paused" : "MeetOps is recording")
            .font(.headline)
          Elapsed(state: context.state).font(.subheadline.monospacedDigit())
        }
        Spacer()
        StopButton()
      }
      .padding()
      .activityBackgroundTint(Color.black)
      .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label(context.state.isPaused ? "Paused" : "Recording", systemImage: "mic.fill")
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(state: context.state).monospacedDigit()
        }
        DynamicIslandExpandedRegion(.bottom) {
          StopButton()
        }
      } compactLeading: {
        StatusDot(paused: context.state.isPaused)
      } compactTrailing: {
        Elapsed(state: context.state).monospacedDigit().frame(maxWidth: 52)
      } minimal: {
        StatusDot(paused: context.state.isPaused)
      }
    }
  }
}

@available(iOS 16.2, *)
private struct Elapsed: View {
  let state: RecordingActivityAttributes.ContentState
  var body: some View {
    if state.isPaused {
      Text(Duration.seconds(state.elapsedSeconds).formatted(.time(pattern: .hourMinuteSecond)))
    } else {
      Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
    }
  }
}

private struct StatusDot: View {
  let paused: Bool
  var body: some View {
    Image(systemName: paused ? "pause.circle.fill" : "record.circle")
      .foregroundColor(paused ? .yellow : Color(red: 0.94, green: 0.27, blue: 0.27))
  }
}

/// iOS 17+: an in-place Stop (App Intent, runs in the app). iOS 16: a link that opens the app on its Record tab,
/// where the user taps Stop (an iOS 16 widget can't run code in the app).
private struct StopButton: View {
  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: StopRecordingIntent()) {
        Label("Stop", systemImage: "stop.fill")
      }
      .tint(Color(red: 0.94, green: 0.27, blue: 0.27))
    } else {
      Link(destination: URL(string: "meetops://record")!) {
        Label("Stop", systemImage: "stop.fill")
      }
    }
  }
}
