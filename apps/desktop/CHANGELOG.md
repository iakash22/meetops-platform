# @meetops/desktop

## Unreleased

- Feature: recording uploads in the Tauri app now go through `createNativeUploadApi(invoke)` (Rust `api_request` + raw-body `upload_put`), and pending chunks persist in the encrypted Rust disk store (`chunk_put`/`chunk_get`/`chunk_delete`) via the new `createNativeChunkStore`; deletion after upload is verified. Retry/backoff and resume-from-last-chunk on reconnect come from the existing queue. Web dev/tests stay on the in-memory store + simulated API.

- Security: `upload_put` now takes the body as a raw IPC payload (`InvokeBody::Raw`) with the presigned descriptor in the `x-meetops-upload` header; the 64 MiB cap is checked before any copy and JSON bodies are refused (no ~4x number-array deserialisation).
- Security: `chunk_put` enforces the same 64 MiB (non-empty) cap.
- Deps: root pnpm override pins `node-forge` to 1.4.2.
- Chore: `cargo clippy -- -D warnings` is clean (`Loopback::wait` is test-only; doc-list lint in `api.rs`).
