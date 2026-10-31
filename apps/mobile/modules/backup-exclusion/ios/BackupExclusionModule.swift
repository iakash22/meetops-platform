import ExpoModulesCore
import Foundation

/// R4 + R5 for the recordings folder: sets NSURLIsExcludedFromBackupKey (no iCloud/Finder backup) and
/// NSFileProtectionCompleteUntilFirstUserAuthentication (new files inside inherit the folder's class), then reads
/// both back. Resolves true only when both are confirmed, so the JS side can fail closed.
public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    AsyncFunction("exclude") { (uriString: String) -> Bool in
      guard var url = URL(string: uriString), url.isFileURL else {
        throw Exception(name: "InvalidUri", description: "Expected a file:// uri")
      }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)

      let fm = FileManager.default
      try fm.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)

      let excluded = try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
      let protection = try fm.attributesOfItem(atPath: url.path)[.protectionKey] as? FileProtectionType
      let protected = protection == .completeUntilFirstUserAuthentication || protection == .complete
        || protection == .completeUnlessOpen
      return excluded && protected
    }
  }
}
