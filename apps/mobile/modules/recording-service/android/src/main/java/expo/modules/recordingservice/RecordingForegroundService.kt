package expo.modules.recordingservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

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
    /** Update the ongoing notification title/body for the session id passed by JS. */
    const val ACTION_UPDATE = "expo.modules.recordingservice.UPDATE"
    /**
     * Package-local broadcast to the native recorder (chunk-crypto SegmentRecorderModule) on a native Stop: it closes
     * the mic and seals the open segment itself, so ending capture never waits on JS. Same string on both sides
     * (the modules don't depend on each other).
     */
    const val ACTION_CAPTURE_STOP = "expo.modules.recordingservice.CAPTURE_STOP"
    /** Sent by the segment recorder when it took the session and started sealing (a seal is in flight). */
    const val ACTION_CAPTURE_SEALING = "expo.modules.recordingservice.CAPTURE_SEALING"
    /** Sent by the segment recorder when the seal finished (success or failure): killing is now safe. */
    const val ACTION_CAPTURE_SEALED = "expo.modules.recordingservice.CAPTURE_SEALED"
    private const val TAG = "RecordingService"
    /**
     * Long extra on CAPTURE_STOP, echoed by the recorder on SEALING/SEALED. Seal progress for any other capture (a
     * late SEALED from an earlier one) is ignored, so it can never cut a newer capture's grace short.
     */
    const val EXTRA_CAPTURE_ID = "captureId"
    private var nextCaptureId = 0L
    /** The capture the current native stop belongs to; -1 = none (seal signals are ignored). */
    @Volatile private var stopCaptureId = -1L
    /** Assigned per start, sent with the native stop. */
    @Volatile private var captureId = -1L
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
    /** Without JS: time for the native recorder to seal before the process-kill fallback (recovery covers the rest). */
    const val NATIVE_STOP_GRACE_MS = 5000L
    /**
     * Upper bound while the segment recorder reports a seal in flight (SEALING without SEALED yet). The kill waits
     * for SEALED instead of a fixed grace, so an encryption seal is never killed partway; this is only the backstop
     * for a recorder that hangs (shutdown 5 s + seal of the last segment fit well inside it).
     */
    const val NATIVE_SEAL_TIMEOUT_MS = 15_000L
    @Volatile private var sealing = false
    @Volatile private var jsListeningAtStop = false
    private var sealReceiver: BroadcastReceiver? = null
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

    private val kill = Runnable { Process.killProcess(Process.myPid()) }

    @Synchronized private fun schedule(ms: Long) {
      cancelWatchdog()
      watchdog = kill
      main.postDelayed(kill, ms)
    }

    /** The recorder began sealing: hold the kill until SEALED (bounded by NATIVE_SEAL_TIMEOUT_MS). */
    @Synchronized fun onSealing(id: Long) {
      if (id < 0 || id != stopCaptureId) return // another (earlier) capture, or untagged
      if (watchdog == null) return // JS already acknowledged
      sealing = true
      schedule(NATIVE_SEAL_TIMEOUT_MS)
    }

    /** Seal done: without JS end now; with JS, give it its normal grace from here. */
    @Synchronized fun onSealed(id: Long) {
      if (id < 0 || id != stopCaptureId) return // a late SEALED for an earlier capture must not kill this one
      sealing = false
      if (watchdog == null) return
      schedule(if (jsListeningAtStop) JS_STOP_GRACE_MS else 0L)
    }

    /** Listens for the recorder's seal progress until the process ends (applicationContext outlives stopSelf). */
    @Synchronized fun listenForSeal(ctx: Context) {
      if (sealReceiver != null) return
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
          when (i?.action) {
            ACTION_CAPTURE_SEALING -> onSealing(i.getLongExtra(EXTRA_CAPTURE_ID, -1L))
            ACTION_CAPTURE_SEALED -> onSealed(i.getLongExtra(EXTRA_CAPTURE_ID, -1L))
          }
        }
      }
      val f = IntentFilter().apply {
        addAction(ACTION_CAPTURE_SEALING)
        addAction(ACTION_CAPTURE_SEALED)
      }
      try {
        ContextCompat.registerReceiver(ctx.applicationContext, r, f, ContextCompat.RECEIVER_NOT_EXPORTED)
        sealReceiver = r
      } catch (e: Exception) {
        Log.w(TAG, "seal receiver registration failed; falling back to the fixed grace", e)
      }
    }

    /**
     * Native-driven Stop (R7): capture must end even when JS is gone (app swiped away, JS runtime torn down) or
     * never answers. The native segment recorder is told directly (ACTION_CAPTURE_STOP) and stops and seals on its
     * own. As a last resort, if JS doesn't call stop() within the grace period, the process is ended (the only way
     * to close an expo-audio mic); the segment recorder's "stopped" sentinel then lets the next launch keep the
     * sealed recording (held) instead of discarding it. Never resumes.
     */
    @Synchronized fun armWatchdog(jsListening: Boolean) {
      jsListeningAtStop = jsListening
      // A seal reported in flight (SEALING arrived first) keeps its longer bound; SEALED then decides.
      schedule(if (sealing) NATIVE_SEAL_TIMEOUT_MS else if (jsListening) JS_STOP_GRACE_MS else NATIVE_STOP_GRACE_MS)
    }

    /** Seal signals from now on count only when tagged with this capture's id. */
    @Synchronized fun beginNativeStop(): Long {
      sealing = false
      stopCaptureId = captureId
      return captureId
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

    /** Module start(): a fresh start clears any earlier cancel and returns the stable capture id. */
    @Synchronized fun beginStart(): Long {
      cancelRequested = false
      captureId = ++nextCaptureId
      stopCaptureId = -1L
      sealing = false
      return captureId
    }

    /**
     * True when `id` is the decimal string of the capture assigned by the current beginStart().
     * Empty, unparseable, or stale ids fail closed (do not match). Pending starts already have a
     * captureId, so JS can stop a start that has not reached onStartCommand yet.
     */
    @Synchronized fun matchesSession(id: String): Boolean {
      if (id.isEmpty()) return false
      val parsed = id.toLongOrNull() ?: return false
      return parsed >= 0L && parsed == captureId
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
    if (intent?.action == ACTION_UPDATE) {
      val id = intent.getStringExtra("id") ?: ""
      if (matchesSession(id) && running) {
        val title = intent.getStringExtra("title") ?: "Recording"
        val body = intent.getStringExtra("body") ?: ""
        getSystemService(NotificationManager::class.java)?.notify(
          NOTIFICATION_ID, buildNotification(title, body))
      }
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
    val id = beginNativeStop()
    listenForSeal(this)
    // Close the mic natively first: no JS round trip (swipe-away with a dead JS runtime included).
    try {
      sendBroadcast(Intent(ACTION_CAPTURE_STOP).setPackage(packageName).putExtra(EXTRA_CAPTURE_ID, id))
    } catch (_: Exception) {
      // Broadcast failed: the watchdog below still ends capture.
    }
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
