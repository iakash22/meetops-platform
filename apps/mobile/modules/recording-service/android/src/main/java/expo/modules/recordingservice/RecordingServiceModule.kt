package expo.modules.recordingservice

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the microphone foreground service (R2). start() is only called from the Record tab's
 * user-initiated begin, so Android 14's "visible user action" rule holds. The notification's Stop action
 * emits "onStopRequested"; JS then ends capture.
 *
 * start() returns the stable capture id assigned by beginStart() (the same Long used as EXTRA_CAPTURE_ID).
 * JS must pass that id to update() and stop(). A missing, unparseable, or mismatched id is a no-op
 * (fail closed), so a stale handle cannot cancel a newer recording. The #318 start/stop handshake
 * (beginStart / requestStop / markRunningUnlessCancelled) is unchanged.
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
      val id = RecordingForegroundService.beginStart()
      RecordingForegroundService.cancelWatchdog()
      ContextCompat.startForegroundService(ctx, intent)
      id.toString()
    }

    Function("update") { id: String, title: String, body: String ->
      // Fail closed: a stale or empty id must not rewrite the current notification.
      if (!RecordingForegroundService.matchesSession(id)) return@Function
      val ctx = appContext.reactContext ?: return@Function
      if (!RecordingForegroundService.running) return@Function
      ctx.startService(
        Intent(ctx, RecordingForegroundService::class.java)
          .setAction(RecordingForegroundService.ACTION_UPDATE)
          .putExtra("id", id)
          .putExtra("title", title)
          .putExtra("body", body)
      )
    }

    Function("stop") { id: String ->
      // Fail closed: a stale or empty id must not cancel a different (or newer) start.
      if (!RecordingForegroundService.matchesSession(id)) return@Function
      // JS is alive and ending capture itself: no native fallback needed.
      RecordingForegroundService.cancelWatchdog()
      // Atomic with onStartCommand: if the start is still pending (fast Start failure) it sees the cancel and tears
      // itself down on arrival; if it is already up, we stop it here. Never stopService() a pending start: that
      // crashes with "did not then call startForeground".
      val wasRunning = RecordingForegroundService.requestStop()
      val ctx = appContext.reactContext ?: return@Function
      // Idempotent: a stop after the service is gone does nothing more.
      if (!wasRunning) return@Function
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
