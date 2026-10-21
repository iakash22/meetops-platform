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
 * - No `host_permissions` and no content scripts.
 */
export const manifest = {
  name: 'MeetOps AI',
  description: 'Record meetings you are part of, with clear consent.',
  permissions: ['activeTab', 'tabCapture', 'offscreen', 'storage', 'alarms'] as string[],
  host_permissions: [] as string[],
  commands: {
    _execute_action: {
      suggested_key: { default: 'Alt+Shift+M' },
      description: 'Open MeetOps AI',
    },
  },
  action: { default_title: 'MeetOps AI' },
};
