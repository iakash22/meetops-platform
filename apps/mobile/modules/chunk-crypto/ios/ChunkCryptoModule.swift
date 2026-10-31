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
  /// Serializes first-use check-then-create (and delete) so concurrent seal/open calls never race two keys.
  private static let keyLock = NSLock()

  private func baseQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: ChunkCryptoModule.service,
      kSecAttrAccount as String: ChunkCryptoModule.account,
    ]
  }

  private func loadOrCreateKey() throws -> SymmetricKey {
    ChunkCryptoModule.keyLock.lock()
    defer { ChunkCryptoModule.keyLock.unlock() }
    if let existing = try readKey() { return existing }
    let key = SymmetricKey(size: .bits256)
    var add = baseQuery()
    add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    if addStatus == errSecDuplicateItem, let existing = try readKey() {
      return existing  // another process/extension won: use its key, never ours
    }
    guard addStatus == errSecSuccess else {
      throw Exception(name: "KeychainError", description: "Keychain write failed (\(addStatus))")
    }
    return key
  }

  private func readKey() throws -> SymmetricKey? {
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
    return nil
  }

  private static let magic = Data("MOCHUNK1".utf8)
  private static let journalName = "seal-journal.txt"

  private func fileURL(_ uri: String) -> URL {
    if let u = URL(string: uri), u.isFileURL { return u }
    return URL(fileURLWithPath: uri)
  }

  /// Seals `src` into `dir/<seq>.chunk` off the JS thread. Each chunk is written atomically (`.atomic` = tmp +
  /// rename) with complete file protection, then journalled, so a kill leaves only whole chunks and a re-run resumes.
  /// The source is never deleted here.
  private func sealFileImpl(_ src: String, _ dir: String, _ chunkBytes: Int) throws -> [[String: Any]] {
    guard chunkBytes > 0 else { throw Exception(name: "InvalidInput", description: "chunkBytes must be positive") }
    let fm = FileManager.default
    let source = fileURL(src)
    let dest = fileURL(dir)
    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
    let journal = dest.appendingPathComponent(ChunkCryptoModule.journalName)
    var done: [Int: (Int, String)] = [:]
    if let text = try? String(contentsOf: journal, encoding: .utf8) {
      for line in text.split(separator: "\n") {
        let p = line.split(separator: ",")
        if p.count == 3, let seq = Int(p[0]), let len = Int(p[1]) { done[seq] = (len, String(p[2])) }
      }
    }
    let handle = try FileHandle(forReadingFrom: source)
    defer { try? handle.close() }
    let total = Int(try handle.seekToEnd())
    guard total > 0 else { throw Exception(name: "Missing", description: "Recording file missing") }
    let key = try loadOrCreateKey()
    var out: [[String: Any]] = []
    var seq = 0
    var pos = 0
    while pos < total {
      let len = min(chunkBytes, total - pos)
      let chunk = dest.appendingPathComponent("\(seq).chunk")
      if let prior = done[seq], prior.0 == len, fm.fileExists(atPath: chunk.path) {
        out.append(["seq": seq, "sizeBytes": len, "sha256": prior.1])
      } else {
        try handle.seek(toOffset: UInt64(pos))
        guard let plain = try handle.read(upToCount: len), plain.count == len else {
          throw Exception(name: "ReadFailed", description: "Short read")
        }
        let sha = SHA256.hash(data: plain).map { String(format: "%02x", $0) }.joined()
        guard let combined = try AES.GCM.seal(plain, using: key).combined else {
          throw Exception(name: "SealFailed", description: "No combined box")
        }
        try (ChunkCryptoModule.magic + combined).write(to: chunk, options: [.atomic, .completeFileProtection])
        let line = Data("\(seq),\(len),\(sha)\n".utf8)
        if fm.fileExists(atPath: journal.path) {
          let j = try FileHandle(forWritingTo: journal)
          try j.seekToEnd()
          try j.write(contentsOf: line)
          try j.synchronize()
          try j.close()
        } else {
          try line.write(to: journal, options: [.atomic, .completeFileProtection])
        }
        out.append(["seq": seq, "sizeBytes": len, "sha256": sha])
      }
      seq += 1
      pos += len
    }
    try? fm.removeItem(at: journal)
    return out
  }

  public func definition() -> ModuleDefinition {
    Name("ChunkCrypto")

    // Expo runs AsyncFunction bodies off the JS thread.
    AsyncFunction("sealFile") { (src: String, dir: String, chunkBytes: Int) -> [[String: Any]] in
      try self.sealFileImpl(src, dir, chunkBytes)
    }

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
      ChunkCryptoModule.keyLock.lock()
      defer { ChunkCryptoModule.keyLock.unlock() }
      let status = SecItemDelete(self.baseQuery() as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Exception(name: "KeychainError", description: "Keychain delete failed (\(status))")
      }
    }
  }
}
