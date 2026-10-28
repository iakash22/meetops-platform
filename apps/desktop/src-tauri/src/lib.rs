//! MeetOps AI desktop shell (Tauri 2).
//!
//! Commands: `app_info`; the ADR-012 auth commands (`auth_sign_in`, `auth_session`, `auth_sign_out`); the scoped
//! `api_request` (api.rs: configured https API origin, route allowlist, fresh bearer + one 401 retry, kept in Rust) and presigned `upload_put`; and the encrypted offline chunk store (`chunk_put`, `chunk_get`,
//! `chunk_delete`). No command ever returns a token.

mod api;
mod auth;
mod chunk_store;
mod config;
mod error;
mod keychain;
mod loopback;
mod pkce;
mod upload;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

use api::ApiState;
use auth::AuthState;
use chunk_store::ChunkStore;
use error::{CmdError, CmdResult};

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

#[tauri::command]
async fn auth_sign_in(auth: State<'_, AuthState>) -> CmdResult<Value> {
    auth::sign_in(&auth).await
}

#[tauri::command]
async fn auth_session(auth: State<'_, AuthState>) -> CmdResult<Option<Value>> {
    match config::origins() {
        Ok(o) => auth.session(&o).await,
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn auth_sign_out(auth: State<'_, AuthState>) -> CmdResult<()> {
    auth.sign_out(config::origins().ok().as_ref()).await;
    Ok(())
}

#[tauri::command]
async fn upload_put(auth: State<'_, AuthState>, request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    // Raw IPC body: bytes arrive as-is (no JSON number array), and the size cap runs before any copy.
    let body = upload::raw_body(request.body())?.to_vec();
    let upload = upload::upload_header(
        request
            .headers()
            .get(upload::UPLOAD_HEADER)
            .and_then(|v| v.to_str().ok()),
    )?;
    let storage = config::storage_origin()?;
    upload::upload_put(&auth.http, &storage, upload, body).await
}

#[tauri::command]
fn chunk_put(
    chunks: State<'_, ChunkStore>,
    session_id: String,
    index: u32,
    data: Vec<u8>,
) -> CmdResult<()> {
    chunks.put(&session_id, index, &data)
}

#[tauri::command]
fn chunk_get(chunks: State<'_, ChunkStore>, session_id: String, index: u32) -> CmdResult<Vec<u8>> {
    chunks.get(&session_id, index)
}

#[tauri::command]
fn chunk_delete(chunks: State<'_, ChunkStore>, session_id: String) -> CmdResult<()> {
    chunks.delete_session(&session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ApiState::new().expect("API http client"))
        .setup(|app| {
            let store: Arc<dyn keychain::SecretStore> =
                Arc::new(keychain::KeychainStore::new(config::KEYCHAIN_SERVICE));
            let dir = app
                .path()
                .app_local_data_dir()
                .map_err(|_| CmdError::internal().message)?
                .join("chunks");
            // Fail closed: without a persisted chunk key, offline chunk commands are disabled for this launch.
            let chunks = match chunk_store::device_key(store.as_ref(), config::CHUNK_KEY_ACCOUNT) {
                Ok(key) => ChunkStore::new(dir, &key),
                Err(_) => ChunkStore::unavailable(dir),
            };
            app.manage(chunks);
            app.manage(AuthState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            auth_sign_in,
            auth_session,
            auth_sign_out,
            api::api_request,
            upload_put,
            chunk_put,
            chunk_get,
            chunk_delete
        ])
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
