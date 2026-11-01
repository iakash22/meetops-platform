package expo.modules.chunkcrypto

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with a non-exportable Android Keystore key (R5). Sealed format: 12-byte IV || ciphertext+tag,
 * base64. The key never leaves the Keystore; deleteKey() makes every chunk unreadable (logout wipe).
 * Key handling, the chunk envelope and the journal live in [ChunkSealer] (shared with SegmentRecorderModule).
 */
class ChunkCryptoModule : Module() {
  companion object {
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val JOURNAL = "seal-journal.txt"
  }

  /**
   * Seals [src] into [dir]/<seq>.chunk on the module's background queue (never the JS thread). Each chunk is written
   * durably, then journalled, so a kill at any point leaves only whole chunks and a re-run skips what is done.
   * The source is never deleted here.
   */
  private fun sealFileImpl(src: String, dir: String, chunkBytes: Int): List<Map<String, Any>> {
    require(chunkBytes > 0) { "chunkBytes must be positive" }
    val source = File(ChunkSealer.pathOf(src))
    val dest = File(ChunkSealer.pathOf(dir)).apply { mkdirs() }
    val journal = File(dest, JOURNAL)
    val done = ChunkSealer.readJournal(dest, journal).associateBy { it.seq }
    val out = ArrayList<Map<String, Any>>()
    RandomAccessFile(source, "r").use { raf ->
      val total = raf.length()
      require(total > 0) { "Recording file missing" }
      var seq = 0
      var pos = 0L
      val buf = ByteArray(chunkBytes)
      while (pos < total) {
        val len = minOf(chunkBytes.toLong(), total - pos).toInt()
        val prior = done[seq]
        if (prior != null && prior.size == len.toLong()) {
          out.add(ChunkSealer.toJs(prior))
        } else {
          raf.seek(pos)
          raf.readFully(buf, 0, len)
          val sha = ChunkSealer.sealChunk(dest, journal, seq, buf.copyOf(len))
          out.add(mapOf("seq" to seq, "sizeBytes" to len, "sha256" to sha))
        }
        seq += 1
        pos += len
      }
    }
    journal.delete()
    return out
  }

  override fun definition() = ModuleDefinition {
    Name("ChunkCrypto")

    AsyncFunction("seal") { plainB64: String ->
      Base64.encodeToString(ChunkSealer.sealRaw(Base64.decode(plainB64, Base64.NO_WRAP)), Base64.NO_WRAP)
    }

    AsyncFunction("open") { sealedB64: String ->
      val all = Base64.decode(sealedB64, Base64.NO_WRAP)
      require(all.size > IV_BYTES) { "Sealed chunk too short" }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, ChunkSealer.key(), GCMParameterSpec(TAG_BITS, all.copyOfRange(0, IV_BYTES)))
      Base64.encodeToString(cipher.doFinal(all.copyOfRange(IV_BYTES, all.size)), Base64.NO_WRAP)
    }

    // AsyncFunction bodies run on the module's background queue, off the JS thread.
    AsyncFunction("sealFile") { src: String, dir: String, chunkBytes: Int -> sealFileImpl(src, dir, chunkBytes) }

    AsyncFunction("deleteKey") {
      synchronized(ChunkSealer.KEY_LOCK) {
        val ks = ChunkSealer.keyStore()
        if (ks.containsAlias(ChunkSealer.ALIAS)) ks.deleteEntry(ChunkSealer.ALIAS)
      }
    }
  }
}
