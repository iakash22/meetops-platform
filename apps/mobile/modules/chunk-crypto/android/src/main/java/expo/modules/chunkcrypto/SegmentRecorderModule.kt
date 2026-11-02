package expo.modules.chunkcrypto

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Android segment recorder (R5, ADR-015). One continuous AudioRecord -> MediaCodec AAC-LC stream, written as ADTS
 * frames into short segment files. When a segment reaches its frame budget it is closed, sealed into
 * `<dir>/<seq>.chunk` (same envelope as every other chunk, via [ChunkSealer]), journalled, and its plaintext deleted;
 * the next frame goes to the next segment. No samples are dropped between segments (one encoder, one stream), and
 * ADTS frames are self-delimiting, so the chunks concatenated byte by byte are one valid `audio/aac` file whose
 * per-chunk and whole-file sha256 match what the worker's session assembly verifies.
 *
 * Only the open segment (`<seq>.part`, a few seconds) is ever plaintext. Crash safety: sealed chunks + journal
 * survive a kill; `recover()` trims a leftover `.part` to its last whole ADTS frame and seals it (JS calls it only
 * for a recording whose Stop had begun; a capture killed mid-recording is discarded, R7).
 */
class SegmentRecorderModule : Module() {
  companion object {
    private const val SAMPLE_RATE = 44_100
    private const val BIT_RATE = 64_000
    private const val SAMPLES_PER_FRAME = 1024
    private const val JOURNAL = "segments.txt"
    /**
     * Written durably the moment a native Stop (notification Stop, swipe-away) is handled, before sealing. A launch
     * that finds it keeps the recording (sealed via recover(), held) instead of discarding it as an interrupted
     * capture: the user asked to stop, so a kill during the seal must not lose the recording.
     */
    const val STOPPED_SENTINEL = "stopped"
    /** Must match RecordingForegroundService.ACTION_CAPTURE_STOP (modules/recording-service). */
    const val ACTION_CAPTURE_STOP = "expo.modules.recordingservice.CAPTURE_STOP"
    /** ADTS sampling_frequency_index for 44.1 kHz. */
    private const val FREQ_INDEX = 4
    private const val CHANNELS = 1
  }

  private class Session(val dir: File, val framesPerSegment: Int) {
    val journal = File(dir, JOURNAL)
    @Volatile var paused = false
    @Volatile var stopping = false
    @Volatile var failure: Throwable? = null
    /** Set (under the session lock) by abort and by a stop that timed out: no frame or rotation is written after it. */
    var closed = false
    var seq = 0
    var framesInSegment = 0
    var part: FileOutputStream? = null
    lateinit var record: AudioRecord
    lateinit var codec: MediaCodec
    lateinit var thread: Thread
  }

  @Volatile private var session: Session? = null

  /** A native Stop in progress or done, for the JS stop() that follows it. */
  private class NativeStop(val dir: File) {
    val done = CountDownLatch(1)
    @Volatile var failure: Throwable? = null
  }
  @Volatile private var nativeStop: NativeStop? = null
  private var receiver: BroadcastReceiver? = null

  private fun registerStopReceiver() {
    val ctx = appContext.reactContext?.applicationContext ?: return
    unregisterStopReceiver()
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, i: Intent?) {
        if (i?.action == ACTION_CAPTURE_STOP) stopNatively()
      }
    }
    ContextCompat.registerReceiver(ctx, r, IntentFilter(ACTION_CAPTURE_STOP), ContextCompat.RECEIVER_NOT_EXPORTED)
    receiver = r
  }

  private fun unregisterStopReceiver() {
    val r = receiver ?: return
    receiver = null
    try { appContext.reactContext?.applicationContext?.unregisterReceiver(r) } catch (_: Exception) {}
  }

  /**
   * Native Stop: no JS needed. Takes the session (so a later JS stop() waits for this one instead of failing),
   * writes the sentinel, then closes the mic and seals off the main thread.
   */
  private fun stopNatively() {
    val s = synchronized(this) {
      val cur = session ?: return
      session = null
      NativeStop(cur.dir).also { nativeStop = it } to cur
    }
    unregisterStopReceiver()
    val (ns, cur) = s
    try { ChunkSealer.writeDurably(File(cur.dir, STOPPED_SENTINEL), ByteArray(0)) } catch (_: Exception) {}
    Thread({
      try {
        shutdown(cur, 5_000)
        recoverParts(cur.dir)
        check(plaintextLeft(cur.dir).isEmpty()) { "Plaintext segment could not be removed" }
        cur.failure?.let { throw it }
      } catch (t: Throwable) {
        ns.failure = t
      } finally {
        ns.done.countDown()
      }
    }, "meetops-segment-native-stop").start()
  }

  private fun adtsHeader(frameLen: Int): ByteArray {
    val len = frameLen + 7
    val profile = 1 // AAC LC (object type 2) - 1
    return byteArrayOf(
      0xFF.toByte(),
      0xF1.toByte(), // MPEG-4, layer 00, no CRC
      ((profile shl 6) or (FREQ_INDEX shl 2) or (CHANNELS shr 2)).toByte(),
      (((CHANNELS and 3) shl 6) or (len shr 11)).toByte(),
      ((len shr 3) and 0xFF).toByte(),
      (((len and 7) shl 5) or 0x1F).toByte(),
      0xFC.toByte(),
    )
  }

  private fun partFile(s: Session) = File(s.dir, "${s.seq}.part")

  /** Closes the open segment, seals it and deletes its plaintext (only after the chunk is journalled). */
  private fun rotate(s: Session) = synchronized(s) {
    if (s.closed) return@synchronized
    val out = s.part ?: return@synchronized
    out.fd.sync()
    out.close()
    s.part = null
    val f = partFile(s)
    val bytes = f.readBytes()
    if (bytes.isNotEmpty()) {
      ChunkSealer.sealChunk(s.dir, s.journal, s.seq, bytes)
      s.seq += 1
    }
    f.delete()
    s.framesInSegment = 0
  }

  private fun writeFrame(s: Session, data: ByteArray) {
    synchronized(s) {
      if (s.closed) return
      if (s.part == null) s.part = FileOutputStream(partFile(s))
      s.part!!.write(adtsHeader(data.size))
      s.part!!.write(data)
      s.framesInSegment += 1
    }
    if (s.framesInSegment >= s.framesPerSegment) rotate(s)
  }

  /**
   * Bounded shutdown of the recorder thread. Stops it writing first (closed flag under the session lock, so no
   * frame or rotation can land after this returns), then releases the codec/mic and closes the open segment file.
   */
  private fun shutdown(s: Session, graceMs: Long) {
    s.stopping = true
    s.thread.join(graceMs)
    if (s.thread.isAlive) {
      s.thread.interrupt()
      s.thread.join(2_000)
    }
    synchronized(s) {
      s.closed = true
      try { s.part?.close() } catch (_: Exception) {}
      s.part = null
    }
    release(s)
    // Releasing the codec makes a stuck thread fail fast; it can no longer write (closed).
    s.thread.join(2_000)
  }

  /** Overwrites then deletes a plaintext file (best effort on flash; the app sandbox is FBE-encrypted too). */
  private fun secureDelete(f: File) {
    try {
      RandomAccessFile(f, "rw").use { r ->
        val zeros = ByteArray(8192)
        var left = r.length()
        r.seek(0)
        while (left > 0) {
          val n = minOf(left, zeros.size.toLong()).toInt()
          r.write(zeros, 0, n)
          left -= n
        }
        r.fd.sync()
      }
    } catch (_: Exception) {}
    f.delete()
  }

  /** Plaintext left in [dir] (open segments or tmp files). */
  private fun plaintextLeft(dir: File): List<File> =
    dir.listFiles { f -> f.name.endsWith(".part") || f.name.endsWith(".tmp") }?.toList() ?: emptyList()

  private fun drain(s: Session, endOfStream: Boolean) {
    val info = MediaCodec.BufferInfo()
    var tries = 0
    while (true) {
      val idx = s.codec.dequeueOutputBuffer(info, if (endOfStream) 10_000 else 0)
      if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
        if (!endOfStream || ++tries > 200) return
        continue
      }
      if (idx < 0) continue // output format / buffers changed
      val buf = s.codec.getOutputBuffer(idx)!!
      if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
        val data = ByteArray(info.size)
        buf.position(info.offset)
        buf.get(data)
        writeFrame(s, data)
      }
      s.codec.releaseOutputBuffer(idx, false)
      if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
    }
  }

  private fun loop(s: Session) {
    val pcm = ByteArray(SAMPLES_PER_FRAME * 2 * CHANNELS)
    try {
      while (!s.stopping) {
        if (s.paused) {
          Thread.sleep(20)
          continue
        }
        val n = s.record.read(pcm, 0, pcm.size)
        if (n <= 0) continue
        val inIdx = s.codec.dequeueInputBuffer(10_000)
        if (inIdx >= 0) {
          s.codec.getInputBuffer(inIdx)!!.apply { clear(); put(pcm, 0, n) }
          s.codec.queueInputBuffer(inIdx, 0, n, System.nanoTime() / 1000, 0)
        }
        drain(s, false)
      }
      val eos = s.codec.dequeueInputBuffer(10_000)
      if (eos >= 0) s.codec.queueInputBuffer(eos, 0, 0, System.nanoTime() / 1000, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
      drain(s, true)
      rotate(s)
    } catch (t: Throwable) {
      s.failure = t
    }
  }

  private fun release(s: Session) {
    try { s.record.stop() } catch (_: Exception) {}
    s.record.release()
    try { s.codec.stop() } catch (_: Exception) {}
    s.codec.release()
  }

  private fun chunks(dir: File): List<Map<String, Any>> =
    ChunkSealer.readJournal(dir, File(dir, JOURNAL)).map(ChunkSealer::toJs)

  /** Length of the whole ADTS frames at the start of [bytes]. */
  private fun wholeFrames(bytes: ByteArray): Int {
    var end = 0
    while (end + 7 <= bytes.size) {
      if (bytes[end] != 0xFF.toByte() || (bytes[end + 1].toInt() and 0xF6) != 0xF0) break
      val len = ((bytes[end + 3].toInt() and 3) shl 11) or ((bytes[end + 4].toInt() and 0xFF) shl 3) or
        ((bytes[end + 5].toInt() and 0xFF) shr 5)
      if (len < 7 || end + len > bytes.size) break
      end += len
    }
    return end
  }

  /**
   * Crash recovery for [dir]; never leaves plaintext behind and never drops a sealed segment:
   * 1. A sealed `<seq>.chunk` missing from the journal (kill between the chunk write and the journal append) is
   *    opened, verified and re-journalled from its own plaintext size and sha256.
   * 2. A leftover `<seq>.part` whose seq is journalled was already sealed: it is only deleted. Otherwise it is
   *    (re-)sealed from its whole ADTS frames (overwriting any partial chunk) and journalled before it is deleted.
   * 3. Anything still plaintext (a part that can't be sealed, stray `.tmp`) is securely deleted.
   */
  private fun recoverParts(dir: File) {
    val journal = File(dir, JOURNAL)
    val journalled = ChunkSealer.readJournal(dir, journal).map { it.seq }.toMutableSet()
    val parts = dir.listFiles { f -> f.name.endsWith(".part") }?.mapNotNull { f ->
      f.name.removeSuffix(".part").toIntOrNull()?.let { it to f }
    }?.toMap() ?: emptyMap()
    dir.listFiles { f -> f.name.endsWith(".chunk") }?.forEach { c ->
      val seq = c.name.removeSuffix(".chunk").toIntOrNull() ?: return@forEach
      if (seq in journalled || seq in parts) return@forEach // parts are re-sealed below from plaintext
      val plain = try { ChunkSealer.openChunk(c) } catch (_: Exception) { null }
      if (plain != null && plain.isNotEmpty()) {
        ChunkSealer.journal(journal, seq, plain)
        journalled.add(seq)
      } else {
        c.delete() // unreadable (torn write): no plaintext left to recover it from
      }
    }
    for ((seq, p) in parts.toSortedMap()) {
      try {
        if (seq !in journalled) {
          val bytes = RandomAccessFile(p, "r").use { r -> ByteArray(r.length().toInt()).also { r.readFully(it) } }
          val end = wholeFrames(bytes)
          if (end > 0) ChunkSealer.sealChunk(dir, journal, seq, bytes.copyOf(end))
          bytes.fill(0)
        }
      } catch (_: Exception) {
        // Can't seal: fall through to the secure delete (plaintext never stays).
      }
      secureDelete(p)
    }
    plaintextLeft(dir).forEach { secureDelete(it) }
  }

  override fun definition() = ModuleDefinition {
    Name("SegmentRecorder")

    @SuppressLint("MissingPermission") // JS checks RECORD_AUDIO (canRecord) before begin; AudioRecord fails closed.
    AsyncFunction("start") { dir: String, segmentMs: Int ->
      check(session == null) { "Already recording" }
      nativeStop?.let { check(it.done.count == 0L) { "Previous capture still stopping" } }
      require(segmentMs in 1_000..60_000) { "segmentMs out of range" }
      ChunkSealer.key() // fail closed before the mic opens
      val d = File(ChunkSealer.pathOf(dir)).apply { mkdirs() }
      val frames = maxOf(1, (segmentMs.toLong() * SAMPLE_RATE / SAMPLES_PER_FRAME / 1000).toInt())
      val s = Session(d, frames)
      val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      s.record = AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SAMPLES_PER_FRAME * 8))
      check(s.record.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable" }
      val fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, CHANNELS).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, SAMPLES_PER_FRAME * 2 * CHANNELS)
      }
      s.codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      try {
        s.codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        s.codec.start()
        s.record.startRecording()
      } catch (e: Exception) {
        release(s)
        throw e
      }
      s.thread = Thread({ loop(s) }, "meetops-segment-recorder").apply { start() }
      nativeStop = null
      session = s
      registerStopReceiver()
    }

    Function("pause") { session?.let { it.paused = true; try { it.record.stop() } catch (_: Exception) {} } }
    Function("resume") { session?.let { it.record.startRecording(); it.paused = false } }
    Function("isRecording") {
      val s = session
      s != null && !s.paused && s.failure == null && s.record.recordingState == AudioRecord.RECORDSTATE_RECORDING
    }

    // Stop: drain the encoder, seal the last segment; resolves with every chunk in seq order. Never returns while
    // plaintext is left: a segment the thread didn't finish (join timeout, failure) is sealed here or securely
    // deleted, and if plaintext still remains the stop fails.
    AsyncFunction("stop") {
      unregisterStopReceiver()
      val s = synchronized(this@SegmentRecorderModule) { session.also { session = null } }
      if (s == null) {
        // A native Stop already took the session: wait for its seal, then report the same chunks.
        val ns = nativeStop ?: throw IllegalStateException("Not recording")
        check(ns.done.await(30, TimeUnit.SECONDS)) { "Native stop timed out" }
        nativeStop = null
        ns.failure?.let { throw it }
        return@AsyncFunction chunks(ns.dir)
      }
      shutdown(s, 15_000)
      recoverParts(s.dir)
      check(plaintextLeft(s.dir).isEmpty()) { "Plaintext segment could not be removed" }
      s.failure?.let { throw it }
      chunks(s.dir)
    }

    // Logout / failed begin: writes stop first (closed under the lock), the thread is joined (bounded), then the
    // folder is deleted, so no late write can recreate a file in it.
    AsyncFunction("abort") {
      unregisterStopReceiver()
      val s = synchronized(this@SegmentRecorderModule) { session.also { session = null } }
      nativeStop?.let { ns ->
        // Logout during a native Stop: let its writes finish, then the folder goes.
        ns.done.await(30, TimeUnit.SECONDS)
        nativeStop = null
        ns.dir.deleteRecursively()
      }
      if (s != null) {
        shutdown(s, 10_000)
        plaintextLeft(s.dir).forEach { secureDelete(it) }
        s.dir.deleteRecursively()
      }
    }

    // Launch: did a native Stop (notification Stop, swipe-away) begin for this capture before it was killed?
    Function("stoppedNatively") { dir: String -> File(ChunkSealer.pathOf(dir), STOPPED_SENTINEL).exists() }

    OnDestroy { unregisterStopReceiver() }

    // After a kill during Stop: seal what the leftover segment holds and list every chunk.
    AsyncFunction("recover") { dir: String ->
      val d = File(ChunkSealer.pathOf(dir))
      if (!d.exists()) return@AsyncFunction emptyList<Map<String, Any>>()
      recoverParts(d)
      chunks(d)
    }
  }
}
