/**
 * Recording-consent gate. Recording may only start after the user has seen
 * the notice in this popup session and explicitly acknowledged it.
 * Acknowledgement is not persisted: it is required for every recording.
 */
export const CONSENT_NOTICE =
  "Recording captures this tab's audio. Only record meetings where " +
  'you have the right to do so and all participants have been informed and agree. ' +
  "Recording is visible in Chrome's tab indicator and can be stopped at any time.";

export type ConsentState =
  { status: 'unseen' } | { status: 'shown' } | { status: 'acknowledged'; acknowledgedAt: number };

export const initialConsent = (): ConsentState => ({ status: 'unseen' });

export function showNotice(state: ConsentState): ConsentState {
  return state.status === 'unseen' ? { status: 'shown' } : state;
}

export function acknowledge(state: ConsentState, now: number = Date.now()): ConsentState {
  if (state.status !== 'shown') {
    throw new Error('Consent notice must be shown before it can be acknowledged');
  }
  return { status: 'acknowledged', acknowledgedAt: now };
}

export function canStartRecording(state: ConsentState): boolean {
  return state.status === 'acknowledged';
}
