# @meetops/desktop

## Unreleased

- Fix (M-1, consent): discards are durable. A device-wide tombstone (`chunk_tombstone`) is written before any delete is attempted, and Rust refuses chunk and metadata writes for a tombstoned recording. At startup, tombstoned recordings are only deleted and never re-queued. This covers two cases: a delete that failed before a restart, and one account discarding another account's recording.
- Security (N-1): the chunk-store owner is derived in Rust from the authenticated session (`AuthState::owner`), and chunk commands no longer accept an `owner` from the webview. Account dir names are now an HMAC keyed from the device key (`chunk-owner.v2`).
- Fix (N-2): local-delete retries back off and are capped at 8 per launch. The tombstone retries on the next launch.
- Fix (N-3): metadata saves are serialized per recording, and they are flushed and closed before a delete. In-flight uploads stop at the next chunk once a recording is discarded.
- Fix: the pending upload queue now survives restarts. Queue metadata is stored encrypted beside the chunks, and on the first pass for each account, leftover recordings are re-queued. Leftovers with no metadata are deleted, and the 7-day retention applies to restored items.
- Fix (L-2): verified deletion uses the new `chunk_exists` command, so it also sees chunks written by earlier launches.
- Fix (L-3): if a delete fails during discard or retention, the record is kept with `pendingDelete` and the delete is retried on every pass, so no orphans are left.
- Security (L-1): chunk storage is namespaced per `userId:organizationId`. The directory name is a sha256 hash of the account, and the account is bound into the AES-GCM AAD (`meetops.chunk.v2`). Every chunk command now takes `owner`, and a new `chunk_list` command was added. Chunks written by older builds, which used the un-namespaced layout, are no longer read.
- Chore: chunk_store tests clean up their temp dirs.
- Feature: recording uploads in the Tauri app now go through `createNativeUploadApi(invoke)` (Rust `api_request` + raw-body `upload_put`), and pending chunks persist in the encrypted Rust disk store (`chunk_put`/`chunk_get`/`chunk_delete`) via the new `createNativeChunkStore`; deletion after upload is verified. Retry/backoff and resume-from-last-chunk on reconnect come from the existing queue. Web dev/tests stay on the in-memory store + simulated API.

- Security: `upload_put` now takes the body as a raw IPC payload (`InvokeBody::Raw`) with the presigned descriptor in the `x-meetops-upload` header; the 64 MiB cap is checked before any copy and JSON bodies are refused (no ~4x number-array deserialisation).
- Security: `chunk_put` enforces the same 64 MiB (non-empty) cap.
- Deps: root pnpm override pins `node-forge` to 1.4.2.
- Chore: `cargo clippy -- -D warnings` is clean (`Loopback::wait` is test-only; doc-list lint in `api.rs`).
