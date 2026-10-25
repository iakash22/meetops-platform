import { useId, type ReactNode } from 'react';
import type { AuthStatus } from '../../src/lib/auth/messages.js';
import {
  CONSENT_CONFIRMATION,
  CONSENT_NOTICE,
  canStartRecording,
  type ConsentState,
} from '../../src/lib/consent.js';
import { formatElapsed } from '../../src/lib/format.js';
import type { StatusPayload } from '../../src/lib/messages.js';
import { OPEN_FROM_TOOLBAR } from './popup-errors.js';

const REASONS: Record<NonNullable<AuthStatus['reason']>, string> = {
  unauthorized: 'Your session was rejected.',
  refresh_rejected: 'Your sign-in was revoked.',
  org_switch: 'You switched organization.',
  expired: 'Your pairing expired.',
};

/** Pill copy for each pairing state; `undefined` is "still asking the background". */
export function pillFor(auth: AuthStatus | undefined): { label: string; tone: string } {
  switch (auth?.state) {
    case undefined:
      return { label: 'Checking…', tone: 'muted' };
    case 'paired':
      return { label: 'Paired', tone: 'paired' };
    case 'pairing':
      return { label: 'Pairing…', tone: 'pending' };
    case 'repair_required':
      return { label: 'Pair again', tone: 'warning' };
    default:
      return { label: 'Not paired', tone: 'muted' };
  }
}

export function StatusPill({ auth }: { auth: AuthStatus | undefined }) {
  const { label, tone } = pillFor(auth);
  return (
    <span className={`mo-pill mo-pill--${tone}`} role="status" aria-label={`Pairing: ${label}`}>
      <span className="mo-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function Logo() {
  return (
    <svg className="mo-logo" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="#007BA7" />
      <path
        d="M7.5 19.5V9l6.5 7 6.5-7v10.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandHeader({
  auth,
  showPill = true,
}: {
  auth?: AuthStatus | undefined;
  showPill?: boolean;
}) {
  return (
    <header className="mo-header">
      <div className="mo-brand">
        <Logo />
        <h1 className="mo-wordmark">
          MeetOps <span className="mo-wordmark__ai">AI</span>
        </h1>
      </div>
      {showPill && <StatusPill auth={auth} />}
    </header>
  );
}

export function PopupFrame({ children }: { children: ReactNode }) {
  return <main className="mo-popup">{children}</main>;
}

/** Shown instead of the controls when popup.html is opened outside the action popup. */
export function OpenFromToolbar() {
  return (
    <PopupFrame>
      <BrandHeader showPill={false} />
      <hr className="mo-divider" />
      <section className="mo-section" aria-label="Open from toolbar">
        <p className="mo-notice">{OPEN_FROM_TOOLBAR}</p>
      </section>
    </PopupFrame>
  );
}

export interface PairingViewProps {
  auth: AuthStatus | undefined;
  onPair: () => void;
  onUnpair: () => void;
}

/** ADR-005 pairing state: Pair (user gesture) / pairing in progress / paired (Unpair) / re-pair required. */
export function PairingView({ auth, onPair, onUnpair }: PairingViewProps) {
  if (!auth) return null;
  return (
    <section className="mo-section" aria-label="Account pairing">
      {auth.state === 'paired' ? (
        <>
          <p className="mo-muted">Paired with your organization.</p>
          <button type="button" className="mo-btn mo-btn--ghost" onClick={onUnpair}>
            Unpair
          </button>
        </>
      ) : auth.state === 'pairing' ? (
        <>
          <p className="mo-muted">Confirm the pairing in the MeetOps tab that just opened.</p>
          <button type="button" className="mo-btn mo-btn--secondary" onClick={onPair}>
            Restart pairing
          </button>
        </>
      ) : (
        <>
          <p className="mo-muted">
            {auth.state === 'repair_required' && auth.reason
              ? `${REASONS[auth.reason]} Pair again to continue.`
              : 'Pair this browser with your MeetOps workspace to upload recordings.'}
          </p>
          <button type="button" className="mo-btn mo-btn--primary" onClick={onPair}>
            {auth.state === 'repair_required' ? 'Pair again' : 'Pair with MeetOps'}
          </button>
        </>
      )}
    </section>
  );
}

export interface RecorderViewProps {
  status: StatusPayload;
  consent: ConsentState;
  now: number;
  /** Primary when paired (the main action), secondary while pairing is still the next step. */
  emphasis: 'primary' | 'secondary';
  /** A start attempt is in flight: Record stays disabled. */
  starting?: boolean;
  onConsentChange: (checked: boolean) => void;
  onRecord: () => void;
  onStop: () => void;
  onDismissWarning: () => void;
}

export function RecorderView(p: RecorderViewProps) {
  const { status, consent } = p;
  const active =
    status.status === 'starting' || status.status === 'recording' || status.status === 'stopping';
  return (
    <section className="mo-section" aria-label="Recording">
      {status.incomplete && (
        <div
          className="mo-callout mo-callout--error"
          role="alert"
          aria-label="Incomplete recording"
        >
          <p>
            <strong>Recording incomplete.</strong> Some audio was lost because local storage was
            full, so this recording will be discarded instead of submitted.
          </p>
        </div>
      )}
      {status.storageWarning && (
        <div className="mo-callout mo-callout--warning" role="alert" aria-label="Storage warning">
          <p>{status.storageWarning}</p>
          <button type="button" className="mo-btn mo-btn--ghost" onClick={p.onDismissWarning}>
            Dismiss
          </button>
        </div>
      )}
      {status.status === 'error' ? (
        <div className="mo-callout mo-callout--error" role="alert" aria-label="Recording error">
          <p>{status.lastError ?? 'Recording stopped unexpectedly.'}</p>
          <button type="button" className="mo-btn mo-btn--ghost" onClick={p.onStop}>
            Dismiss
          </button>
        </div>
      ) : active ? (
        <div className="mo-live" aria-live="polite">
          <p className="mo-live__line">
            <span className="mo-live-dot" aria-hidden="true" />
            <span className="mo-live__state">
              {status.status === 'recording' ? 'Recording' : status.status}
            </span>
            {status.startedAt !== undefined && (
              <span className="mo-mono">{formatElapsed(p.now - status.startedAt)}</span>
            )}
            <span className="mo-muted">· {status.chunks ?? 0} chunks</span>
          </p>
          <button
            type="button"
            className="mo-btn mo-btn--secondary"
            onClick={p.onStop}
            disabled={status.status === 'stopping'}
          >
            Stop recording
          </button>
        </div>
      ) : (
        <ConsentGate
          consent={consent}
          emphasis={p.emphasis}
          starting={p.starting ?? false}
          onConsentChange={p.onConsentChange}
          onRecord={p.onRecord}
        />
      )}
    </section>
  );
}

/**
 * Consent gate in front of "Record this meeting" (contracts v0.4.1, G11). Record stays disabled until the user
 * ticks the confirmation. The tick is for this meeting only: the popup clears it after every start attempt.
 */
export function ConsentGate(p: {
  consent: ConsentState;
  emphasis: 'primary' | 'secondary';
  starting: boolean;
  onConsentChange: (checked: boolean) => void;
  onRecord: () => void;
}) {
  const id = useId();
  const confirmed = canStartRecording(p.consent);
  return (
    <div className="mo-consent" role="group" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="mo-consent__title">
        Recording consent
      </p>
      <p id={`${id}-notice`} className="mo-consent__notice">
        {CONSENT_NOTICE}
      </p>
      <label className="mo-consent__check" htmlFor={`${id}-confirm`}>
        <input
          id={`${id}-confirm`}
          type="checkbox"
          checked={confirmed}
          aria-describedby={`${id}-notice`}
          onChange={(e) => p.onConsentChange(e.currentTarget.checked)}
        />
        <span>{CONSENT_CONFIRMATION}</span>
      </label>
      <button
        type="button"
        className={`mo-btn mo-btn--${p.emphasis}`}
        disabled={!confirmed || p.starting}
        aria-describedby={confirmed ? undefined : `${id}-hint`}
        onClick={p.onRecord}
      >
        Record this meeting
      </button>
      {!confirmed && (
        <p id={`${id}-hint`} className="mo-consent__hint">
          Tick the box above to enable recording. You confirm this for each meeting.
        </p>
      )}
    </div>
  );
}

/** Non-field errors render as a toast pinned to the bottom of the popup. */
export function ErrorToast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="mo-toast" role="alert">
      {message}
    </div>
  );
}

export interface PopupViewProps extends Omit<RecorderViewProps, 'emphasis'>, PairingViewProps {
  error: string;
}

export function PopupView({ error, auth, onPair, onUnpair, ...recorder }: PopupViewProps) {
  return (
    <PopupFrame>
      <BrandHeader auth={auth} />
      <hr className="mo-divider" />
      <PairingView auth={auth} onPair={onPair} onUnpair={onUnpair} />
      <RecorderView {...recorder} emphasis={auth?.state === 'paired' ? 'primary' : 'secondary'} />
      <ErrorToast message={error} />
    </PopupFrame>
  );
}
