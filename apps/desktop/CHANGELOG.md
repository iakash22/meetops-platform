# @meetops/desktop

## Unreleased

- Security: `upload_put` now takes the body as a raw IPC payload (`InvokeBody::Raw`) with the presigned descriptor in the `x-meetops-upload` header; the 64 MiB cap is checked before any copy and JSON bodies are refused (no ~4x number-array deserialisation).
- Security: `chunk_put` enforces the same 64 MiB (non-empty) cap.
- Deps: root pnpm override pins `node-forge` to 1.4.2.
- Chore: `cargo clippy -- -D warnings` is clean (`Loopback::wait` is test-only; doc-list lint in `api.rs`).
