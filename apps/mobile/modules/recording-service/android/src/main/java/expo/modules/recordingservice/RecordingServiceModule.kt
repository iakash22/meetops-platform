package expo.modules.recordingservice

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the microphone foreground service (R2). start() is only called from the Record tab's
 * user-initiated begin, so Android 14's "visible user action" rule holds. The notification's Stop action
 * emits "onStopRequested"; JS then ends capture.
 */
class RecordingServiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RecordingService")
    Events("onStopRequested", "onServiceLost")

    OnCreate {
      RecordingForegroundService.onStop = { sendEvent("onStopRequested", emptyMap<String, Any>()) }
      RecordingForegroundService.onLost = { sendEvent("onServiceLost", emptyMap<String, Any>()) }
    }
    OnDestroy {
      RecordingForegroundService.onStop = null
      RecordingForegroundService.onLost = null
    }

    Function("start") { title: String, body: String ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("No context")
      val intent = Intent(ctx, RecordingForegroundService::class.java)
        .setAction(RecordingForegroundService.ACTION_START)
        .putExtra("title", title)
        .putExtra("body", body)
      ContextCompat.startForegroundService(ctx, intent)
    }

    Function("stop") {
      val ctx = appContext.reactContext ?: return@Function
      // Idempotent: a second stop (or a stop after the service is gone) does nothing.
      if (!RecordingForegroundService.running) return@Function
      RecordingForegroundService.stopRequestedByApp = true
      ctx.stopService(Intent(ctx, RecordingForegroundService::class.java))
    }

    Function("isRunning") { RecordingForegroundService.running }

    // The JS side lifts the background pause only when this is true.
    Function("isConfirmed") {
      val ctx = appContext.reactContext ?: return@Function false
      RecordingForegroundService.running && RecordingForegroundService.isNotificationShowing(ctx)
    }
  }
}
