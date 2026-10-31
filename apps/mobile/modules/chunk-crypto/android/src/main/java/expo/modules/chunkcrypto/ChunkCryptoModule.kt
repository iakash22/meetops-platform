package expo.modules.chunkcrypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyStore
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
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun key(): SecretKey {
    (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build()
    )
    return gen.generateKey()
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

    AsyncFunction("deleteKey") {
      val ks = keyStore()
      if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    }
  }
}
