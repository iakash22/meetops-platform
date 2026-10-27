import type { ConsentMethod } from '@meetops/contracts/types';

/**
 * Recording-consent gate (contracts v0.4.1, G11). The popup shows the notice and a confirmation checkbox; "Record this
 * meeting" stays disabled until the user ticks it. The confirmation belongs to one meeting and one recording: it lives
 * only in the open popup, is never saved as a preference, and is cleared after every start attempt. The background
 * binds it to the tab and meeting (consent-registry.ts) and sends it to the API as the session's attestation.
 */
export const CONSENT_NOTICE =
  "Recording captures this tab's audio. Only record meetings where " +
  'you have the right to do so and all participants have been informed and agree. ' +
  "Recording is visible in Chrome's tab indicator and can be stopped at any time.";

/** The statement the user ticks. It asserts what POPUP_CONSENT_METHOD records. */
export const CONSENT_CONFIRMATION =
  'Everyone in this meeting has been told it will be recorded and agrees to it.';

/**
 * The contracts consent method the popup's confirmation attests: participants were informed AND agreed. A
 * notify-only option ('all_parties_notified') is deliberately not offered until Arch + Sec decide the UX for it.
 */
export const POPUP_CONSENT_METHOD: ConsentMethod = 'all_parties_consented';

export type ConsentState = { status: 'unconfirmed' } | { status: 'confirmed'; confirmedAt: number };

export const initialConsent = (): ConsentState => ({ status: 'unconfirmed' });

/** The checkbox changed. Unticking withdraws the confirmation. */
export function setConfirmed(checked: boolean, now: number = Date.now()): ConsentState {
  return checked ? { status: 'confirmed', confirmedAt: now } : initialConsent();
}

export function canStartRecording(state: ConsentState): boolean {
  return state.status === 'confirmed';
}

/** The ACK_CONSENT payload for the meeting about to be recorded. Throws if the user has not confirmed. */
export function consentGrant(
  state: ConsentState,
  meetingId: string,
): { meetingId: string; method: ConsentMethod } {
  if (!canStartRecording(state)) throw new Error('Confirm recording consent first');
  return { meetingId, method: POPUP_CONSENT_METHOD };
}
