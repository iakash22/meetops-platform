package expo.modules.chunkcrypto

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

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
    /** ADTS sampling_frequency_index for 44.1 kHz. */
    private const val FREQ_INDEX = 4
    private const val CHANNELS = 1
  }

  private class Session(val dir: File, val framesPerSegment: Int) {
    val journal = File(dir, JOURNAL)
    @Volatile var paused = false
    @Volatile var stopping = false
    @Volatile var failure: Throwable? = null
    var seq = 0
    var framesInSegment = 0
    var part: FileOutputStream? = null
    lateinit var record: AudioRecord
    lateinit var codec: MediaCodec
    lateinit var thread: Thread
  }

  @Volatile private var session: Session? = null

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

  /** Closes the open segment, seals it and deletes its plaintext. */
  private fun rotate(s: Session) {
    val out = s.part ?: return
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
    if (s.part == null) s.part = FileOutputStream(partFile(s))
    s.part!!.write(adtsHeader(data.size))
    s.part!!.write(data)
    s.framesInSegment += 1
    if (s.framesInSegment >= s.framesPerSegment) rotate(s)
  }

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

  /** Trims a leftover plaintext segment to its last whole ADTS frame, seals it, then deletes it. */
  private fun recoverParts(dir: File) {
    val journal = File(dir, JOURNAL)
    val parts = dir.listFiles { f -> f.name.endsWith(".part") }?.sortedBy { it.name.removeSuffix(".part").toIntOrNull() ?: 0 } ?: return
    for (p in parts) {
      val seq = p.name.removeSuffix(".part").toIntOrNull()
      if (seq != null && !File(dir, "$seq.chunk").exists()) {
        val bytes = RandomAccessFile(p, "r").use { r -> ByteArray(r.length().toInt()).also { r.readFully(it) } }
        var end = 0
        while (end + 7 <= bytes.size) {
          if (bytes[end] != 0xFF.toByte() || (bytes[end + 1].toInt() and 0xF6) != 0xF0) break
          val len = ((bytes[end + 3].toInt() and 3) shl 11) or ((bytes[end + 4].toInt() and 0xFF) shl 3) or
            ((bytes[end + 5].toInt() and 0xFF) shr 5)
          if (len < 7 || end + len > bytes.size) break
          end += len
        }
        if (end > 0) ChunkSealer.sealChunk(dir, journal, seq, bytes.copyOf(end))
      }
      p.delete()
    }
    dir.listFiles { f -> f.name.endsWith(".tmp") }?.forEach { it.delete() }
  }

  override fun definition() = ModuleDefinition {
    Name("SegmentRecorder")

    @SuppressLint("MissingPermission") // JS checks RECORD_AUDIO (canRecord) before begin; AudioRecord fails closed.
    AsyncFunction("start") { dir: String, segmentMs: Int ->
      check(session == null) { "Already recording" }
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
      session = s
    }

    Function("pause") { session?.let { it.paused = true; try { it.record.stop() } catch (_: Exception) {} } }
    Function("resume") { session?.let { it.record.startRecording(); it.paused = false } }
    Function("isRecording") {
      val s = session
      s != null && !s.paused && s.failure == null && s.record.recordingState == AudioRecord.RECORDSTATE_RECORDING
    }

    // Stop: drain the encoder, seal the last segment; resolves with every chunk in seq order.
    AsyncFunction("stop") {
      val s = session ?: throw IllegalStateException("Not recording")
      session = null
      s.stopping = true
      s.thread.join(15_000)
      release(s)
      s.failure?.let { throw it }
      chunks(s.dir)
    }

    // Logout / failed begin: stop without sealing and delete everything for this capture.
    AsyncFunction("abort") {
      val s = session
      session = null
      if (s != null) {
        s.stopping = true
        s.thread.join(5_000)
        release(s)
        s.dir.deleteRecursively()
      }
    }

    // After a kill during Stop: seal what the leftover segment holds and list every chunk.
    AsyncFunction("recover") { dir: String ->
      val d = File(ChunkSealer.pathOf(dir))
      if (!d.exists()) return@AsyncFunction emptyList<Map<String, Any>>()
      recoverParts(d)
      chunks(d)
    }
  }
}
