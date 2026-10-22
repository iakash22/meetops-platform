# Chrome extension (`apps/extension`)

Source: `apps/extension` on `integration/phase-1`, as merged by PR #52 (head `3a8c49f`, merged 2026-10-22 00:27 IST). PR #52 consolidates and supersedes #5 (scaffold), #15 (capture) and #37 (resilience). It reaches `main` with the integration PR (#30).

WXT, Manifest V3, React and TypeScript. The extension's name is **MeetOps AI**. It records the audio of the current tab, with consent, and uploads it in chunks using the `@meetops/contracts` v0.2 recording-session contract.

## Running it

```bash
pnpm --filter @meetops/extension dev        # WXT dev build with reload
pnpm --filter @meetops/extension build      # production build (wxt build)
pnpm --filter @meetops/extension test       # vitest
pnpm --filter @meetops/extension test:e2e   # build + real Alt+Shift+M gesture in headed Chromium
```

`test:e2e` needs Playwright Chromium, `xvfb` and `xdotool`, and `@meetops/contracts` built first. It isn't in CI yet: `.github` is DevOps' area, and #52 lists what's needed.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | The toolbar click (or `Alt+Shift+M`) grants temporary access to the current tab only, which `tabCapture.getMediaStreamId({ targetTabId })` relies on |
| `tabCapture` | Get a tab stream ID, only from the popup click after consent is acknowledged |
| `offscreen` | MV3 service workers have no MediaRecorder; an offscreen document (reason `USER_MEDIA`) records |
| `storage` | `chrome.storage.session` for recorder and consent state across service-worker suspension |
| `alarms` | 30-second watchdog that wakes the service worker to detect a dead recorder |

There are no `host_permissions` and no content scripts. `commands._execute_action` (`Alt+Shift+M`) opens the popup; it isn't a permission. The manifest lives in `src/manifest.ts` so tests can assert this surface.

## Consent flow

1. The popup shows the consent notice (`CONSENT_NOTICE` in `src/lib/consent.ts`). Acknowledgement isn't persisted, so every recording needs a fresh one.
2. When the user acknowledges, the popup sends `ACK_CONSENT { tabId }`. The service worker records consent bound to that tab, valid for **2 minutes** (`CONSENT_TTL_MS`).
3. **Start** gets a stream ID for that tab and sends `START_RECORDING { tabId, streamId, meetingId }`. The service worker **consumes** the consent atomically (one-shot, serialized per store); a missing, expired or wrong-tab record is refused.
4. The stream ID is single-use and bound to the consented tab, and it's verified against `chrome.tabCapture.getCapturedTabs()`. On a mismatch the session is discarded: IndexedDB chunks are deleted and the upload session is aborted.
5. Chrome's tab-capture indicator stays visible, and the popup offers **Stop recording** at any time. The maximum duration is 24 hours.

## Message contract (`src/lib/messages.ts`)

Every message carries a `target`, and the runtime guards (`isBackgroundMessage`, `isOffscreenMessage`) validate its shape. Senders are checked in `src/lib/senders.ts`:

- Popup commands are accepted only from the real action popup (`sender.url === popup.html` with no `sender.tab`).
- The offscreen document obeys only the service worker.

| Direction | Types |
| --- | --- |
| Popup → background | `GET_STATUS`, `ACK_CONSENT { tabId }`, `START_RECORDING { tabId, streamId, meetingId (uuid) }`, `STOP_RECORDING` (also dismisses an error), `DISMISS_WARNING` |
| Background → offscreen | `OFFSCREEN_START { streamId, startedAt, meetingId }`, `OFFSCREEN_STOP`, `OFFSCREEN_DISCARD` |
| Offscreen → background | `REC_STARTED { sessionId }`, `REC_CHUNK { seq }`, `REC_HEARTBEAT { sessionId }`, `REC_STORAGE { event }`, `REC_STOPPED { chunkCount }`, `REC_ERROR { error }` |

Replies are `{ ok: true, status, tabId?, startedAt?, chunks?, lastError?, storageWarning?, incomplete? }` or `{ ok: false, error }`. The local `CaptureStatus` is `idle | starting | recording | stopping | error`, which is separate from the server's `RecordingStatus`. Offscreen calls time out after 10 seconds and go to the error state.

## Resilience and upload

- Chunks are queued in IndexedDB with a size cap and eviction. The queue drains when the service worker restarts, and a heartbeat watchdog runs alongside it.
- If pending audio is lost to the cap, the session is marked `incomplete` and aborted with `local_storage_exhausted` rather than submitted.
- The upload flow follows contracts v0.2: init with `meetingId`, then a presigned PUT per chunk with signed `content-length` and `x-amz-checksum-sha256`. A 403 triggers a refresh and retry, and the session is completed with the chunk digests. Transport is HTTPS-only; `http://localhost` and `127.0.0.1` are allowed in dev builds only.

## Known gaps (as of #52)

- **Uploader is a stub:** `StubUploadClient`; there's no real API client yet.
- **`meetingId` is interim:** `resolveMeetingId()` returns a fresh UUID until a Backend endpoint creates the meeting (TODO(meeting-api)).
- **Sign-in:** the popup's sign-in button is disabled ("Sign-in coming soon").
- **e2e:** not wired into CI.

## Earlier gaps (from #5)

| Gap | Status after #52 |
| --- | --- |
| No Stop button | **Fixed**: `STOP_RECORDING` and a "Stop recording" button |
| No `activeTab` | **Fixed**: `activeTab` declared; capture uses the click or shortcut grant |
| `streamId` unused | **Fixed**: consumed by the offscreen recorder, single-use and verified against the consented tab |
| Name "MeetOps" | **Fixed**: "MeetOps AI" |
| Double quotes | **Fixed**: single quotes, per the repo Prettier config |
