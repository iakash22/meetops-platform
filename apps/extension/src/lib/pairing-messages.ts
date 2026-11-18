/**
 * Shared unpaired copy. Start is fail-closed until the extension is paired
 * (see background-handler). Keep these strings in one place so the popup
 * prompt and the Start error stay consistent.
 */
export const PAIRING_REQUIRED_REASON = 'This browser is not paired with MeetOps AI';
export const PAIRING_REQUIRED_CTA = 'Pair the extension first.';

/** Shown after Start is refused because the extension is unpaired. */
export const PAIRING_REQUIRED_MESSAGE = `${PAIRING_REQUIRED_REASON}, so recording was not started. ${PAIRING_REQUIRED_CTA}`;

/** Popup hint when unpaired: recording cannot start until the user pairs. */
export const UNPAIRED_PROMPT_MESSAGE = `${PAIRING_REQUIRED_REASON}, so recording cannot start. ${PAIRING_REQUIRED_CTA}`;
