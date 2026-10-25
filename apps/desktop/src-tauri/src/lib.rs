//! MeetOps AI desktop shell (Tauri 2).
//!
//! M1 exposes a single read-only command, `app_info`, used by the Settings screen. Offline recording,
//! secure token storage (OS keychain) and uploads are later Phase 8 milestones.

use serde::Serialize;

/// Static app/platform info for the UI. Mirrored by `AppInfo` in `src/lib/native.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
}

/// Pure helper so the command logic is unit-testable without a running app.
pub fn build_app_info(name: &str, version: &str) -> AppInfo {
    AppInfo {
        name: name.to_owned(),
        version: version.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
    }
}

/// Returns the product name and version from tauri.conf.json plus the OS and CPU architecture.
/// Takes no input and touches no files, network or secrets.
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let pkg = app.package_info();
    build_app_info(&pkg.name, &pkg.version.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running the MeetOps desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_name_version_and_platform() {
        let info = build_app_info("MeetOps AI", "0.0.0");
        assert_eq!(info.name, "MeetOps AI");
        assert_eq!(info.version, "0.0.0");
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }
}
