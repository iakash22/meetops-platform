package expo.modules.recordingservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
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

    /**
     * Set by the module's stop(). When it arrives before the service reached onStartCommand (a fast Start failure),
     * the pending start posts its mandatory foreground notification and immediately removes it again.
     */
    @Volatile private var cancelRequested = false
    /** How long JS gets to end capture after a native Stop (notification, swipe-away) before native ends it. */
    const val JS_STOP_GRACE_MS = 3000L
    private val main = Handler(Looper.getMainLooper())
    private var watchdog: Runnable? = null

    @Synchronized fun notifyStopOnce(lost: Boolean) {
      if (stopNotified) return
      stopNotified = true
      val listener = if (lost) onLost else onStop
      listener?.invoke()
    }

    /** JS acknowledged (it called stop()): cancel the native fallback. */
    @Synchronized fun cancelWatchdog() {
      watchdog?.let { main.removeCallbacks(it) }
      watchdog = null
    }

    /**
     * Native-driven Stop (R7): capture must end even when JS is gone (app swiped away, JS runtime torn down) or
     * never answers. If JS has no listener, or doesn't call stop() within the grace period, the process is ended:
     * expo-audio's recorder lives in this process, so that is the only native way to close the mic. The unfinalized
     * file is then discarded by the next launch's recovery (marker phase "recording"). Never resumes.
     */
    @Synchronized fun armWatchdog(jsListening: Boolean) {
      cancelWatchdog()
      val kill = Runnable { Process.killProcess(Process.myPid()) }
      watchdog = kill
      main.postDelayed(kill, if (jsListening) JS_STOP_GRACE_MS else 0L)
    }

    @Synchronized fun resetStopLatch() {
      stopNotified = false
    }

    /*
     * Start/stop handshake. stop() runs on the module thread and onStartCommand on the main thread, so
     * "is a start pending?" and "is the service up?" must be decided under one lock. Otherwise stop() can read
     * running == false just after onStartCommand checked cancelRequested and just before it set running = true:
     * nobody stops the service and the "recording" notification stays up (Tester r4 item 1). Under the lock
     * exactly one side wins: either stop() sees running and stops the service, or the start sees the cancel.
     */

    /** Module start(): a fresh start clears any earlier cancel. */
    @Synchronized fun beginStart() {
      cancelRequested = false
    }

    /** Module stop(): records the cancel and returns whether the service was already up (caller then stops it). */
    @Synchronized fun requestStop(): Boolean {
      cancelRequested = true
      stopRequestedByApp = true
      return running
    }

    /** onStartCommand after startForeground: true = keep running; false = a stop arrived first, tear down. */
    @Synchronized fun markRunningUnlessCancelled(): Boolean {
      if (cancelRequested) return false
      running = true
      return true
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      nativeStop()
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
    if (!markRunningUnlessCancelled()) {
      // stop() arrived while this start was still pending: never leave a "recording" notification behind.
      removeNotification()
      running = false
      stopRequestedByApp = true
      stopSelf()
      return START_NOT_STICKY
    }
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
    removeNotification()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // App swiped away: stop capture rather than keep recording without UI (R7), natively if JS can't.
    nativeStop()
  }

  /** Notification Stop or swipe-away: indicator goes now; JS ends capture, or the watchdog does. */
  private fun nativeStop() {
    val jsListening = onStop != null
    notifyStopOnce(lost = false)
    stopRequestedByApp = true
    running = false
    removeNotification()
    stopSelf()
    armWatchdog(jsListening)
  }

  private fun removeNotification() {
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
      // Not in the foreground yet/anymore.
    }
    getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
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
    // No launch intent (shouldn't happen): no Open action rather than an empty Intent that does nothing.
    val open = launch?.let { PendingIntent.getActivity(this, 2, it, flags) }
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(title)
      .setContentText(body)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, "Stop", stop)
    if (open != null) builder.setContentIntent(open).addAction(0, "Open", open)
    return builder.build()
  }
}
