# Chrome extension (`apps/extension`)

Source: `apps/extension` on `integration/phase-1`. PR #52 (merged 2026-10-22 00:27 IST) consolidated and superseded #5 (scaffold), #15 (capture) and #37 (resilience). Later changes:

- **#55**: a durable pending-discard marker for captured-tab mismatches (merged 2026-10-23 21:18 IST).
- **#60**: ADR-005 pairing, the nonce handoff and rotating bearer tokens (merged 2026-10-23 22:10 IST).

WXT, Manifest V3, React and TypeScript. The extension's name is **MeetOps AI**. It records the audio of the current tab, with consent, and uploads it in chunks using the `@meetops/contracts` recording-session contract (introduced in v0.2; `integration/phase-1` is on 0.3.3).

## Running it

```bash
pnpm --filter @meetops/extension dev        # WXT dev build with reload
pnpm --filter @meetops/extension build      # production build (wxt build)
pnpm --filter @meetops/extension test       # vitest
pnpm --filter @meetops/extension test:e2e   # build + real Alt+Shift+M gesture in headed Chromium
```

`test:e2e` needs Playwright Chromium, `xvfb` and `xdotool`, and `@meetops/contracts` built first. It isn't in CI yet: `.github` is DevOps' area, and #52 lists what's needed.

## Permissions

| Permission   | Why                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`  | The toolbar click (or `Alt+Shift+M`) grants temporary access to the current tab only, which `tabCapture.getMediaStreamId({ targetTabId })` relies on |
| `tabCapture` | Get a tab stream ID, only from the popup click after consent is acknowledged                                                                         |
| `offscreen`  | MV3 service workers have no MediaRecorder; an offscreen document (reason `USER_MEDIA`) records                                                       |
| `storage`    | `chrome.storage.session` for recorder and consent state across service-worker suspension                                                             |
| `alarms`     | 30-second watchdog that wakes the service worker to detect a dead recorder                                                                           |

There are no `host_permissions` and no content scripts. `commands._execute_action` (`Alt+Shift+M`) opens the popup; it isn't a permission. `externally_connectable` allows only the configured web origin (`WXT_WEB_ORIGIN`) to message the extension, for the pairing handoff. The manifest lives in `src/manifest.ts` so tests can assert this surface.

## Consent flow

1. The popup shows the consent notice (`CONSENT_NOTICE` in `src/lib/consent.ts`). Acknowledgement isn't persisted, so every recording needs a fresh one.
2. When the user acknowledges, the popup sends `ACK_CONSENT { tabId }`. The service worker records consent bound to that tab, valid for **2 minutes** (`CONSENT_TTL_MS`).
3. **Start** gets a stream ID for that tab and sends `START_RECORDING { tabId, streamId, meetingId }`. The service worker **consumes** the consent atomically (one-shot, serialized per store); a missing, expired or wrong-tab record is refused.
4. The stream ID is single-use and bound to the consented tab, and it's verified against `chrome.tabCapture.getCapturedTabs()`. On a mismatch the session is discarded: IndexedDB chunks are deleted and the upload session is aborted. A durable pending-discard marker (#55, `src/lib/pending-discard.ts`) makes the discard survive a service-worker restart, and it runs before any queue drain.
5. Chrome's tab-capture indicator stays visible, and the popup offers **Stop recording** at any time. The maximum duration is 24 hours.

## Pairing (ADR-005, #60)

The extension authenticates with rotating bearer tokens, not the web session cookie.

1. **Pair with MeetOps** in the popup (a user click) sends `AUTH_PAIR`. The service worker creates a nonce in `chrome.storage.session`. The nonce is single-use, and a one-shot `chrome.alarms` alarm deletes it after 5 minutes.
2. The worker opens the web pairing page (`<WXT_WEB_ORIGIN>/extension/pair`, from web #69 and #84) with the nonce, `deviceId` and extension ID in the URL fragment.
3. The web page (signed in with its session) gets a pairing code and sends `{ pairingCode, nonce }` through `externally_connectable`. The worker accepts it only from the exact web origin, after schema and nonce checks; anything else gets no response.
4. The worker exchanges the code at `POST /auth/extension-token` and stores the tokens only in `chrome.storage.session`. They are never logged. The bearer header goes only to the exact API origin (`WXT_API_ORIGIN`). Presigned PUTs never carry it.
5. The popup shows `unpaired`, `pairing`, `paired` (with **Unpair**) or `repair_required` (with a reason: `unauthorized`, `refresh_rejected`, `org_switch` or `expired`).

The web and API origins are baked in at build time. `WXT_WEB_ORIGIN` defaults to `https://app.meetops.ai` and `WXT_API_ORIGIN` to `https://api.meetops.ai`. They must be https bare origins, and localhost is allowed only in dev builds. A bad value fails the build. See `apps/extension/README.md`.

## Message contract (`src/lib/messages.ts`)

Every message carries a `target`, and the runtime guards (`isBackgroundMessage`, `isOffscreenMessage`) validate its shape. Senders are checked in `src/lib/senders.ts`:

- Popup commands are accepted only from the real action popup (`sender.url === popup.html` with no `sender.tab`).
- The offscreen document obeys only the service worker.
- External messages (`onMessageExternal`) are accepted only from the exact `WXT_WEB_ORIGIN`, and only for the pairing handoff.

| Direction              | Types                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Popup → background     | `AUTH_STATUS`, `AUTH_PAIR`, `AUTH_UNPAIR`, `GET_STATUS`, `ACK_CONSENT { tabId }`, `START_RECORDING { tabId, streamId, meetingId (uuid) }`, `STOP_RECORDING` (also dismisses an error), `DISMISS_WARNING` |
| Background → offscreen | `OFFSCREEN_START { streamId, startedAt, meetingId }`, `OFFSCREEN_STOP`, `OFFSCREEN_DISCARD`                                                                                                              |
| Offscreen → background | `REC_STARTED { sessionId }`, `REC_CHUNK { seq }`, `REC_HEARTBEAT { sessionId }`, `REC_STORAGE { event }`, `REC_STOPPED { chunkCount }`, `REC_ERROR { error }`                                            |

Replies are `{ ok: true, status, tabId?, startedAt?, chunks?, lastError?, storageWarning?, incomplete? }` or `{ ok: false, error }`. The local `CaptureStatus` is `idle | starting | recording | stopping | error`, which is separate from the server's `RecordingStatus`. Offscreen calls time out after 10 seconds and go to the error state.

## Resilience and upload

- Chunks are queued in IndexedDB with a size cap and eviction. The queue drains when the service worker restarts, and a heartbeat watchdog runs alongside it.
- If pending audio is lost to the cap, the session is marked `incomplete` and aborted with `local_storage_exhausted` rather than submitted.
- The upload flow follows the contracts recording-session API (0.3.x; added in v0.2): init with `meetingId`, then a presigned PUT per chunk with signed `content-length` and `x-amz-checksum-sha256`; contracts require a sha256 on uploads. A 403 triggers a refresh and retry, and the session is completed with the chunk digests. Transport is HTTPS-only; `http://localhost` and `127.0.0.1` are allowed in dev builds only.

## Known gaps (on `integration/phase-1`)

- **Uploader is a stub:** `StubUploadClient`; there's no real API client yet. When one lands, it must use `auth.apiFetch()` for API routes and the fetch transport (no bearer) for presigned PUTs.
- **Pairing endpoints aren't in the API yet:** contracts define `EXTENSION_AUTH_PATHS` (`/auth/extension/pair`, `/auth/extension-token`, `/auth/extension/refresh`, `/auth/extension/revoke`), but `apps/api` doesn't implement them.
- **`meetingId` is interim:** `resolveMeetingId()` returns a fresh UUID until a Backend endpoint creates the meeting (TODO(meeting-api)).
- **e2e:** the extension's `test:e2e` isn't wired into CI. The QA workflow's e2e job covers the web app only.

## Earlier gaps (from #5)

| Gap               | Status after #52                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| No Stop button    | **Fixed**: `STOP_RECORDING` and a "Stop recording" button                                        |
| No `activeTab`    | **Fixed**: `activeTab` declared; capture uses the click or shortcut grant                        |
| `streamId` unused | **Fixed**: consumed by the offscreen recorder, single-use and verified against the consented tab |
| Name "MeetOps"    | **Fixed**: "MeetOps AI"                                                                          |
| Sign-in disabled  | **Replaced** by ADR-005 pairing (#60)                                                            |
| Double quotes     | **Fixed**: single quotes, per the repo Prettier config                                           |
