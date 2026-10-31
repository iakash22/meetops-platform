package expo.modules.chunkcrypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with a non-exportable Android Keystore key (R5). Sealed format: 12-byte IV || ciphertext+tag,
 * base64. The key never leaves the Keystore; deleteKey() makes every chunk unreadable (logout wipe).
 */
class ChunkCryptoModule : Module() {
  companion object {
    private const val ALIAS = "meetops_chunk_key_v1"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    /** Serializes first-use check-then-create (and delete) so concurrent seal/open calls never race two keys. */
    private val KEY_LOCK = Any()
    /** Same envelope the JS store writes ("MOCHUNK1"). */
    private val MAGIC = "MOCHUNK1".toByteArray(Charsets.US_ASCII)
    private const val JOURNAL = "seal-journal.txt"
  }

  private fun pathOf(uri: String): String = if (uri.startsWith("file:")) Uri.parse(uri).path!! else uri

  private fun writeDurably(target: File, bytes: ByteArray) {
    val tmp = File(target.parentFile, target.name + ".tmp")
    FileOutputStream(tmp).use { out ->
      out.write(bytes)
      out.fd.sync()
    }
    if (!tmp.renameTo(target)) throw IllegalStateException("rename failed")
  }

  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  /**
   * Seals [src] into [dir]/<seq>.chunk on the module's background queue (never the JS thread). Each chunk is written
   * to a tmp file, fsynced and renamed, then journalled, so a kill at any point leaves only whole chunks and a re-run
   * skips what is already done. The source is never deleted here.
   */
  private fun sealFileImpl(src: String, dir: String, chunkBytes: Int): List<Map<String, Any>> {
    require(chunkBytes > 0) { "chunkBytes must be positive" }
    val source = File(pathOf(src))
    val dest = File(pathOf(dir)).apply { mkdirs() }
    val journal = File(dest, JOURNAL)
    val done = HashMap<Int, Pair<Long, String>>()
    if (journal.exists()) journal.readLines().forEach { line ->
      val p = line.split(",")
      if (p.size == 3) p[0].toIntOrNull()?.let { seq -> p[1].toLongOrNull()?.let { done[seq] = it to p[2] } }
    }
    val out = ArrayList<Map<String, Any>>()
    RandomAccessFile(source, "r").use { raf ->
      val total = raf.length()
      require(total > 0) { "Recording file missing" }
      var seq = 0
      var pos = 0L
      val buf = ByteArray(chunkBytes)
      while (pos < total) {
        val len = minOf(chunkBytes.toLong(), total - pos).toInt()
        val chunk = File(dest, "$seq.chunk")
        val prior = done[seq]
        if (prior != null && prior.first == len.toLong() && chunk.exists()) {
          out.add(mapOf("seq" to seq, "sizeBytes" to len, "sha256" to prior.second))
        } else {
          raf.seek(pos)
          raf.readFully(buf, 0, len)
          val plain = buf.copyOf(len)
          val sha = hex(MessageDigest.getInstance("SHA-256").digest(plain))
          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          cipher.init(Cipher.ENCRYPT_MODE, key())
          writeDurably(chunk, MAGIC + cipher.iv + cipher.doFinal(plain))
          FileOutputStream(journal, true).use { j ->
            j.write("$seq,$len,$sha\n".toByteArray(Charsets.US_ASCII))
            j.fd.sync()
          }
          out.add(mapOf("seq" to seq, "sizeBytes" to len, "sha256" to sha))
        }
        seq += 1
        pos += len
      }
    }
    journal.delete()
    return out
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun key(): SecretKey = synchronized(KEY_LOCK) {
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

  override fun definition() = ModuleDefinition {
    Name("ChunkCrypto")

    AsyncFunction("seal") { plainB64: String ->
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key())
      val iv = cipher.iv
      val sealed = cipher.doFinal(Base64.decode(plainB64, Base64.NO_WRAP))
      Base64.encodeToString(iv + sealed, Base64.NO_WRAP)
    }

    AsyncFunction("open") { sealedB64: String ->
      val all = Base64.decode(sealedB64, Base64.NO_WRAP)
      require(all.size > IV_BYTES) { "Sealed chunk too short" }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, all.copyOfRange(0, IV_BYTES)))
      Base64.encodeToString(cipher.doFinal(all.copyOfRange(IV_BYTES, all.size)), Base64.NO_WRAP)
    }

    // AsyncFunction bodies run on the module's background queue, off the JS thread.
    AsyncFunction("sealFile") { src: String, dir: String, chunkBytes: Int -> sealFileImpl(src, dir, chunkBytes) }

    AsyncFunction("deleteKey") {
      synchronized(KEY_LOCK) {
        val ks = keyStore()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
      }
    }
  }
}
