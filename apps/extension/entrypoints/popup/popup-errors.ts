/**
 * User-facing popup error copy. The background rejects commands that do not come from the action popup
 * (e.g. popup.html opened as a normal tab). That guard is a security check, not something a user can act
 * on, so its raw text is never shown: in the real popup it is dropped, elsewhere it becomes a friendly hint.
 */
export const POPUP_ONLY_ERROR = 'Commands must come from the popup';

export const OPEN_FROM_TOOLBAR =
  'MeetOps works from the toolbar. Click the MeetOps icon in your browser toolbar to pair or record this meeting.';

export const OFFLINE_MESSAGE = "Can't reach MeetOps. Check your connection and try again.";
export const RELOADED_MESSAGE = 'MeetOps was updated. Close and reopen this popup.';
const NETWORK_ERROR =
  /failed to fetch|networkerror|network request failed|err_internet_disconnected/i;
export const UNSUPPORTED_PAGE_MESSAGE =
  'Open the meeting in this tab (an https page), then press Record.';
export const MEETING_RESOLVE_MESSAGE =
  "Couldn't set up this meeting in MeetOps. Try again in a moment.";
const EXTENSION_RELOADED = /extension context invalidated|receiving end does not exist/i;

export const isPopupOnlyError = (raw: string): boolean => raw.includes(POPUP_ONLY_ERROR);

/** Map a raw error to what the popup shows. Empty string means "show nothing". */
export function popupErrorMessage(raw: string | undefined, inPopup: boolean): string {
  if (!raw) return '';
  if (isPopupOnlyError(raw)) return inPopup ? '' : OPEN_FROM_TOOLBAR;
  if (NETWORK_ERROR.test(raw)) return OFFLINE_MESSAGE;
  if (EXTENSION_RELOADED.test(raw)) return RELOADED_MESSAGE;
  if (raw.includes('UNSUPPORTED_PAGE')) return UNSUPPORTED_PAGE_MESSAGE;
  if (raw.startsWith('Meeting resolve failed')) return MEETING_RESOLVE_MESSAGE;
  return raw;
}

export type PopupContext = 'checking' | 'popup' | 'tab';

/**
 * The action popup is not a tab, so chrome.tabs.getCurrent() resolves undefined there; popup.html opened
 * as a page (bookmark, devtools, a test harness) resolves a tab.
 */
export async function detectPopupContext(
  getCurrent: () => Promise<unknown> = () => chrome.tabs.getCurrent(),
): Promise<Exclude<PopupContext, 'checking'>> {
  try {
    return (await getCurrent()) === undefined ? 'popup' : 'tab';
  } catch {
    return 'popup';
  }
}
