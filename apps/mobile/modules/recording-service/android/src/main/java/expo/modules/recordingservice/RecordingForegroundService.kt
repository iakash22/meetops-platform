package expo.modules.recordingservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Microphone foreground service: an ongoing, non-dismissible notification with Stop (ends capture now)
 * and Open (brings the app forward). It records nothing itself; it only keeps the user-started capture
 * visible and allowed while the app is in the background.
 */
class RecordingForegroundService : Service() {
  companion object {
    /** Confirmed visible: notifications enabled and our ongoing notification is posted. */
    fun isNotificationShowing(ctx: android.content.Context): Boolean {
      val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
      if (!nm.areNotificationsEnabled()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = nm.getNotificationChannel(CHANNEL)
        if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
      }
      return nm.activeNotifications.any { it.id == NOTIFICATION_ID }
    }

    const val ACTION_START = "expo.modules.recordingservice.START"
    const val ACTION_STOP = "expo.modules.recordingservice.STOP"
    private const val CHANNEL = "meetops_recording"
    const val NOTIFICATION_ID = 4711
    @Volatile var running = false
    @Volatile var onStop: (() -> Unit)? = null
    /** Fired when the service goes away without the app asking (killed, revoked, crashed). */
    @Volatile var onLost: (() -> Unit)? = null
    /** Set by the module right before an app-requested stop, so onDestroy can tell the two apart. */
    @Volatile var stopRequestedByApp = false
    /** One stop notification per capture: notification Stop, task removal and onDestroy never double-fire. */
    @Volatile private var stopNotified = false

    @Synchronized fun notifyStopOnce(lost: Boolean) {
      if (stopNotified) return
      stopNotified = true
      if (lost) onLost?.invoke() else onStop?.invoke()
    }

    @Synchronized fun resetStopLatch() {
      stopNotified = false
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      notifyStopOnce(lost = false)
      stopRequestedByApp = true
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra("title") ?: "Recording"
    val body = intent?.getStringExtra("body") ?: ""
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    stopRequestedByApp = false
    resetStopLatch()
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(title, body), type)
    } catch (e: Exception) {
      // e.g. ForegroundServiceStartNotAllowedException, missing permission, SecurityException on Android 14:
      // no visible indicator means no capture (R2). Tell JS, then go away.
      running = false
      notifyStopOnce(lost = true)
      stopRequestedByApp = true
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    // Never restarted by the OS after a kill: capture must not resume on its own (R7).
    return START_NOT_STICKY
  }

  /** True only when the service is in the foreground AND its notification is actually showing. */
  fun notificationShowing(): Boolean = isNotificationShowing(this)

  override fun onDestroy() {
    val wasRunning = running
    running = false
    // The service died without the app stopping it (system kill, notification permission revoked, crash):
    // capture must end too (R2, R7). JS stops the recorder on onLost and never resumes.
    if (wasRunning && !stopRequestedByApp) notifyStopOnce(lost = true)
    stopRequestedByApp = false
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // App swiped away: stop capture rather than keep recording without UI (R7).
    notifyStopOnce(lost = false)
    stopRequestedByApp = true
    stopSelf()
  }

  private fun buildNotification(title: String, body: String): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stop = PendingIntent.getService(
      this, 1, Intent(this, RecordingForegroundService::class.java).setAction(ACTION_STOP), flags)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val open = PendingIntent.getActivity(this, 2, launch ?: Intent(), flags)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(title)
      .setContentText(body)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
      .addAction(0, "Open", open)
      .build()
  }
}
