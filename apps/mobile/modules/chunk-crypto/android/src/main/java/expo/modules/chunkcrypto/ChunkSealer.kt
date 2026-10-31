package expo.modules.chunkcrypto

import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Shared AES-256-GCM sealing (R5) for ChunkCryptoModule and SegmentRecorderModule: one non-exportable Keystore key,
 * one chunk envelope ("MOCHUNK1" || 12-byte IV || ciphertext+tag), one durable write (tmp + fsync + rename) and one
 * append-only journal format ("seq,sizeBytes,sha256" per line, plaintext size + hash).
 */
internal object ChunkSealer {
  const val ALIAS = "meetops_chunk_key_v1"
  private val MAGIC = "MOCHUNK1".toByteArray(Charsets.US_ASCII)
  /** Serializes first-use check-then-create (and delete) so concurrent callers never race two keys. */
  val KEY_LOCK = Any()

  fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  fun key(): SecretKey = synchronized(KEY_LOCK) {
    (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return@synchronized it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    gen.generateKey()
  }

  fun pathOf(uri: String): String = if (uri.startsWith("file:")) Uri.parse(uri).path!! else uri

  fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  fun sha256(b: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(b))

  /** Raw IV || ciphertext+tag (the format seal()/open() exchange as base64). */
  fun sealRaw(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return cipher.iv + cipher.doFinal(plain)
  }

  fun writeDurably(target: File, bytes: ByteArray) {
    val tmp = File(target.parentFile, target.name + ".tmp")
    FileOutputStream(tmp).use { out ->
      out.write(bytes)
      out.fd.sync()
    }
    if (!tmp.renameTo(target)) throw IllegalStateException("rename failed")
  }

  /**
   * Seals [plain] into [dir]/<seq>.chunk durably, then journals it. Returns the chunk's plaintext sha256. Callers
   * delete their plaintext only after this returns; a kill in between is repaired by recovery (re-journal or
   * re-seal), so neither the plaintext nor the segment is lost.
   */
  fun sealChunk(dir: File, journal: File, seq: Int, plain: ByteArray): String {
    writeDurably(File(dir, "$seq.chunk"), MAGIC + sealRaw(plain))
    return journal(journal, seq, plain)
  }

  /** Appends (and fsyncs) one journal line for [plain]. A duplicate line for a seq is harmless (last wins). */
  fun journal(journal: File, seq: Int, plain: ByteArray): String {
    val sha = sha256(plain)
    FileOutputStream(journal, true).use { j ->
      j.write("$seq,${plain.size},$sha\n".toByteArray(Charsets.US_ASCII))
      j.fd.sync()
    }
    return sha
  }

  /** Opens a sealed chunk file (envelope + IV + ciphertext+tag). Throws when it is torn or not ours. */
  fun openChunk(f: File): ByteArray {
    val all = f.readBytes()
    require(all.size > MAGIC.size + 12 && all.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) { "Not a chunk" }
    val body = all.copyOfRange(MAGIC.size, all.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), javax.crypto.spec.GCMParameterSpec(128, body.copyOfRange(0, 12)))
    return cipher.doFinal(body.copyOfRange(12, body.size))
  }

  data class Entry(val seq: Int, val size: Long, val sha: String)

  /** Journal entries whose chunk file exists, in seq order. Malformed or orphaned lines are ignored. */
  fun readJournal(dir: File, journal: File): List<Entry> {
    if (!journal.exists()) return emptyList()
    val bySeq = HashMap<Int, Entry>()
    journal.readLines().forEach { line ->
      val p = line.split(",")
      val seq = p.getOrNull(0)?.toIntOrNull()
      val size = p.getOrNull(1)?.toLongOrNull()
      if (p.size == 3 && seq != null && size != null && File(dir, "$seq.chunk").exists()) bySeq[seq] = Entry(seq, size, p[2])
    }
    return bySeq.values.sortedBy { it.seq }
  }

  fun toJs(e: Entry): Map<String, Any> = mapOf("seq" to e.seq, "sizeBytes" to e.size, "sha256" to e.sha)
}
