# Browser extension (P1-NATIVE)

> **Note:** This page describes **open PR #5** (`feat/extension-scaffold`), which is not merged yet. Source: head commit `b3f47f6e63167defc3408a361f74fbcf792fb043`, read via `gh pr view 5` / `gh pr diff 5`.

`apps/extension` (`@meetops/extension`) is built with WXT, Manifest V3, React and TypeScript. Scripts: `dev` (`wxt`), `build` (`wxt build`, output in `dist`), `zip`, `typecheck`, `lint` and `test` (Vitest).

Not implemented yet: the actual MediaRecorder or offscreen document, sign-in (a disabled placeholder button), and upload.

## Consent flow

Implemented in `src/lib/consent.ts` and the popup:

1. `unseen`: the popup shows **Record this meeting**.
2. `shown`: the consent notice is displayed (`CONSENT_NOTICE`) with **I understand and have consent** and **Cancel** buttons.
3. `acknowledged` (stores `acknowledgedAt`): the popup shows **Start recording**.
4. Clicking **Start recording** queries the active tab, calls `chrome.tabCapture.getMediaStreamId` inside the click handler (so it counts as a user gesture), then sends `START_RECORDING`.

Acknowledgement can only follow `shown` (otherwise it throws). It is **not persisted**, so it's required for every recording.

## Manifest permissions

From `src/manifest.ts`, which tests check in both source and the built manifest:

- `permissions`: `["tabCapture"]` only.
- `host_permissions`: none.
- No content scripts.
- `action.default_title`: `MeetOps`.

## Message contract (popup → background)

From `src/lib/messages.ts`. The background service worker ignores any sender other than this extension (`sender.id !== chrome.runtime.id`). Recorder state is held in memory.

| Type              | Payload                                                                                | Response                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET_STATUS`      | None                                                                                   | `{ ok: true, status, tabId? }`                                                                                              |
| `START_RECORDING` | `tabId: number`, `streamId: string` (non-empty), `consentAcknowledgedAt: number` (> 0) | `{ ok: true, status: 'recording', tabId }`, or `{ ok: false, error }` for "Already recording" or "Consent not acknowledged" |
| `STOP_RECORDING`  | None                                                                                   | `{ ok: true, status: 'idle' }`                                                                                              |

`status` is `'idle'` or `'recording'`. Malformed or unknown messages return `{ ok: false, error: 'Unknown or malformed message' }`.
