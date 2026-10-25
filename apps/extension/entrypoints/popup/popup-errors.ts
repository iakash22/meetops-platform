/**
 * User-facing popup error copy. The background rejects commands that do not come from the action popup
 * (e.g. popup.html opened as a normal tab). That guard is a security check, not something a user can act
 * on, so its raw text is never shown: in the real popup it is dropped, elsewhere it becomes a friendly hint.
 */
export const POPUP_ONLY_ERROR = 'Commands must come from the popup';

export const OPEN_FROM_TOOLBAR =
  'MeetOps works from the toolbar. Click the MeetOps icon in your browser toolbar to pair or record this meeting.';

export const isPopupOnlyError = (raw: string): boolean => raw.includes(POPUP_ONLY_ERROR);

/** Map a raw error to what the popup shows. Empty string means "show nothing". */
export function popupErrorMessage(raw: string | undefined, inPopup: boolean): string {
  if (!raw) return '';
  if (isPopupOnlyError(raw)) return inPopup ? '' : OPEN_FROM_TOOLBAR;
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
