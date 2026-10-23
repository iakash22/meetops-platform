import { DEFAULT_WEB_ORIGIN, originMatch } from './lib/auth/origins.js';

/**
 * Manifest fields for the MeetOps AI extension. Kept separate from wxt.config.ts
 * so unit tests can assert the permission surface stays minimal.
 *
 * - `activeTab`: the toolbar click grants temporary access to the current tab
 *   only, which tabCapture.getMediaStreamId({ targetTabId }) relies on. No
 *   persistent host access.
 * - `tabCapture`: obtain a tab stream ID, only from the popup's user click
 *   after the consent notice is acknowledged.
 * - `offscreen`: MV3 service workers have no DOM/MediaRecorder; an offscreen
 *   document (reason USER_MEDIA) consumes the stream and records it.
 * - `storage`: required for chrome.storage.session, used to persist recorder
 *   and consent state across service-worker suspension. Session storage is
 *   in-memory, cleared on browser restart, and not exposed to content scripts.
 * - `alarms`: a 30 s watchdog that wakes the (possibly suspended) service worker to
 *   detect a dead offscreen recorder; heartbeats alone cannot detect silence.
 * - `commands._execute_action`: keyboard shortcut to open the popup (an action
 *   invocation, so it grants activeTab like a toolbar click). Not a permission.
 * - `externally_connectable`: ADR-005 A1.1.5. Only the configured web origin (WXT_WEB_ORIGIN, validated at build
 *   time; localhost only in dev builds) may message the extension for the pairing handoff.
 * - No `host_permissions` and no content scripts.
 */
export function buildManifest(webOrigin: string) {
  return {
    name: 'MeetOps AI',
    description: 'Record meetings you are part of, with clear consent.',
    permissions: ['activeTab', 'tabCapture', 'offscreen', 'storage', 'alarms'] as string[],
    host_permissions: [] as string[],
    externally_connectable: { matches: [originMatch(webOrigin)] },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+M' },
        description: 'Open MeetOps AI',
      },
    },
    action: { default_title: 'MeetOps AI' },
  };
}

/** Manifest with the default web origin (used by tests). */
export const manifest = buildManifest(DEFAULT_WEB_ORIGIN);
