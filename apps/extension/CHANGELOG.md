# @meetops/extension

## Unreleased

- Fix: Start fails closed. The pairing, browser-quota and pending-storage checks are required dependencies, and a missing, throwing or nonsensical answer refuses Start (the local-only stub answers pairing `true` explicitly).
- Fix: Start counts every pending chunk, held or only queued. Pending chunks are never evicted, so Start is refused when the cap has less than one chunk of room left on top of them, instead of starting and then refusing the first chunk.
- Fix: the local recording chunk size equals the server limit (`MAX_CHUNK_BYTES`, 64 MiB), imported from `@meetops/contracts/types` rather than mirrored. This removes the 8 MiB vs 64 MiB mismatch; the Start reserve is one chunk at that size.
- Feature: `resolveMeetingId` no longer uses a random UUID when HTTP uploads are on (`WXT_FEATURE_HTTP_UPLOAD`). The popup sends `RESOLVE_MEETING` (popup-only) to the background, which finds or creates the meeting with `POST /orgs/:organizationId/meetings/resolve` (contracts `ResolveMeetingRequest`/`ResolveMeetingResponse`, TypeBox-validated) through the bearer `apiFetch`.
  - The tab URL is reduced to origin + path first, so query strings such as Zoom `pwd=` and fragments never leave the browser. Non-https pages are refused.
  - Transient failures (408/429/5xx, network) are retried; other 4xx are not.
  - With the flag off (stub uploads), a random UUID is still used.
  - Consent is unchanged: the confirmation tick is still required first, and nothing captures before it.
- Feature: the upload drain treats 413 `PAYLOAD_TOO_LARGE` and 409 (the session is no longer uploading) as terminal. The session is aborted (best effort) and closed locally instead of being retried forever. 404 stays retryable, so local recordings survive an API whose media routes are not enabled.
- Tests: a replayed `complete` after a lost response is idempotent and completes once locally, and retried chunk-URL requests re-sign the same seq. All tests use dummy media bytes.
- UI: friendly popup copy for meeting-resolve failures.
