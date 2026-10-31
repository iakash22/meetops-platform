# @meetops/extension

## Unreleased

- Feature: `resolveMeetingId` no longer uses a random UUID when HTTP uploads are on (`WXT_FEATURE_HTTP_UPLOAD`). The popup sends `RESOLVE_MEETING` (popup-only) to the background, which finds or creates the meeting with `POST /orgs/:organizationId/meetings/resolve` (contracts `ResolveMeetingRequest`/`ResolveMeetingResponse`, TypeBox-validated) through the bearer `apiFetch`.
  - The tab URL is reduced to origin + path first, so query strings such as Zoom `pwd=` and fragments never leave the browser. Non-https pages are refused.
  - Transient failures (408/429/5xx, network) are retried; other 4xx are not.
  - With the flag off (stub uploads), a random UUID is still used.
  - Consent is unchanged: the confirmation tick is still required first, and nothing captures before it.
- Feature: the upload drain treats 413 `PAYLOAD_TOO_LARGE` and 409 (the session is no longer uploading) as terminal. The session is aborted (best effort) and closed locally instead of being retried forever. 404 stays retryable, so local recordings survive an API whose media routes are not enabled.
- Tests: a replayed `complete` after a lost response is idempotent and completes once locally, and retried chunk-URL requests re-sign the same seq. All tests use dummy media bytes.
- UI: friendly popup copy for meeting-resolve failures.
