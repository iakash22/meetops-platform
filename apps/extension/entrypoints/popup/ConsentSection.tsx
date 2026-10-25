import { useId } from 'react';
import {
  CONSENT_CONFIRMATION,
  CONSENT_NOTICE,
  canStartRecording,
  type ConsentState,
} from '../../src/lib/consent.js';

/**
 * Consent gate in front of "Record this meeting" (contracts v0.4.1, G11). The button is disabled until the user ticks
 * the confirmation; the confirmation is for this meeting only and is cleared after every start attempt.
 */
export function ConsentSection(props: {
  consent: ConsentState;
  busy?: boolean;
  onConfirmedChange: (checked: boolean) => void;
  onRecord: () => void;
}) {
  const id = useId();
  const confirmed = canStartRecording(props.consent);
  return (
    <section className="mo-consent" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mo-consent-title">
        Recording consent
      </h2>
      <p id={`${id}-notice`} className="mo-consent-notice">
        {CONSENT_NOTICE}
      </p>
      <label className="mo-consent-check" htmlFor={`${id}-confirm`}>
        <input
          id={`${id}-confirm`}
          type="checkbox"
          checked={confirmed}
          aria-describedby={`${id}-notice`}
          onChange={(e) => props.onConfirmedChange(e.currentTarget.checked)}
        />
        <span>{CONSENT_CONFIRMATION}</span>
      </label>
      <button
        type="button"
        disabled={!confirmed || props.busy}
        aria-describedby={confirmed ? undefined : `${id}-hint`}
        onClick={props.onRecord}
      >
        Record this meeting
      </button>
      {!confirmed && (
        <p id={`${id}-hint`} className="mo-consent-hint">
          Tick the box above to enable recording. You confirm this for each meeting.
        </p>
      )}
    </section>
  );
}
