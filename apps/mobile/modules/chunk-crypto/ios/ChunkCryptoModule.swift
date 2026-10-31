import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// AES-256-GCM for chunk files (R5). The 256-bit key lives in the Keychain as a generic password,
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced, never in backups). Sealed format is
/// CryptoKit's combined box: 12-byte nonce || ciphertext || 16-byte tag, base64. Same layout as Android.
public class ChunkCryptoModule: Module {
  private static let service = "com.meetops.chunk-crypto"
  private static let account = "meetops_chunk_key_v1"

  private func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: ChunkCryptoModule.service,
      kSecAttrAccount as String: ChunkCryptoModule.account,
    ]
  }

  private func loadOrCreateKey() throws -> SymmetricKey {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data, data.count == 32 {
      return SymmetricKey(data: data)
    }
    guard status == errSecItemNotFound else {
      throw Exception(name: "KeychainError", description: "Keychain read failed (\(status))")
    }
    let key = SymmetricKey(size: .bits256)
    var add = baseQuery()
    add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw Exception(name: "KeychainError", description: "Keychain write failed (\(addStatus))")
    }
    return key
  }

  public func definition() -> ModuleDefinition {
    Name("ChunkCrypto")

    AsyncFunction("seal") { (plainB64: String) -> String in
      guard let plain = Data(base64Encoded: plainB64) else {
        throw Exception(name: "InvalidInput", description: "Expected base64")
      }
      let box = try AES.GCM.seal(plain, using: try self.loadOrCreateKey())
      guard let combined = box.combined else {
        throw Exception(name: "SealFailed", description: "No combined box")
      }
      return combined.base64EncodedString()
    }

    AsyncFunction("open") { (sealedB64: String) -> String in
      guard let sealed = Data(base64Encoded: sealedB64) else {
        throw Exception(name: "InvalidInput", description: "Expected base64")
      }
      let box = try AES.GCM.SealedBox(combined: sealed)
      return try AES.GCM.open(box, using: try self.loadOrCreateKey()).base64EncodedString()
    }

    AsyncFunction("deleteKey") {
      let status = SecItemDelete(self.baseQuery() as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Exception(name: "KeychainError", description: "Keychain delete failed (\(status))")
      }
    }
  }
}
