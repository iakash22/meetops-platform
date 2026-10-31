import SwiftUI
import WidgetKit

@main
struct RecordingLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) {
      RecordingLiveActivityWidget()
    }
  }
}
