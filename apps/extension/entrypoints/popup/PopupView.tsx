import {
  discardConfirmMessage,
  HELD_FULL_START_MESSAGE,
  HELD_NEAR_FULL_MESSAGE,
  heldMessage,
} from '../../src/lib/drain.js';
import { memo, useId, type ReactNode } from 'react';
import type { AuthStatus } from '../../src/lib/auth/messages.js';
import {
  CONSENT_CONFIRMATION,
  CONSENT_NOTICE,
  canStartRecording,
  type ConsentState,
} from '../../src/lib/consent.js';
import { MAX_DURATION_MS } from '../../src/lib/contract-limits.js';
import { formatElapsed } from '../../src/lib/format.js';
import type { StatusPayload } from '../../src/lib/messages.js';
import { UNPAIRED_PROMPT_MESSAGE } from '../../src/lib/pairing-messages.js';
import { pendingLabel, type PendingTasks } from '../../src/lib/pending-tasks.js';
import { OPEN_FROM_TOOLBAR } from './popup-errors.js';
import { PrivacyPolicyLink } from '../../src/lib/privacy-link.js';

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

export const StatusPill = memo(function StatusPill({ auth }: { auth: AuthStatus | undefined }) {
  const { label, tone } = pillFor(auth);
  return (
    <span className={`mo-pill mo-pill--${tone}`} role="status" aria-label={`Pairing: ${label}`}>
      <span className="mo-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
});

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

// memo: the popup re-renders every second for the elapsed timer; the header and pairing UI only change with `auth`.
export const BrandHeader = memo(function BrandHeader({
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
});

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
      <footer className="mo-privacy-footer">
        <PrivacyPolicyLink />
      </footer>
    </PopupFrame>
  );
}

export interface PairingViewProps {
  auth: AuthStatus | undefined;
  onPair: () => void;
  onUnpair: () => void;
}

/** ADR-005 pairing state: Pair (user gesture) / pairing in progress / paired (Unpair) / re-pair required. */
export const PairingView = memo(function PairingView({ auth, onPair, onUnpair }: PairingViewProps) {
  if (!auth) return null;
  if (auth.state === 'repair_required') {
    const why = auth.reason ? REASONS[auth.reason] : 'Your sign-in needs to be renewed.';
    return (
      <section className="mo-section" aria-label="Account pairing">
        <div className="mo-callout mo-callout--warning" role="alert" aria-label="Sign-in required">
          <p className="mo-callout__title">Sign in again to keep recording</p>
          <p>{`${why} Pair again to continue.`}</p>
          <p className="mo-muted">
            Recordings already on this device stay queued and upload after you pair again.
          </p>
          <button type="button" className="mo-btn mo-btn--primary" onClick={onPair}>
            Pair again
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="mo-section" aria-label="Account pairing">
      {auth.state === 'paired' ? (
        <div className="mo-row mo-row--center">
          <p className="mo-muted mo-grow">Paired with your organization.</p>
          <button type="button" className="mo-btn mo-btn--ghost" onClick={onUnpair}>
            Unpair
          </button>
        </div>
      ) : auth.state === 'pairing' ? (
        <>
          <p className="mo-muted" aria-live="polite">
            <span className="mo-spinner" aria-hidden="true" />
            Confirm the pairing in the MeetOps tab that just opened.
          </p>
          <button type="button" className="mo-btn mo-btn--secondary" onClick={onPair}>
            Restart pairing
          </button>
        </>
      ) : (
        <>
          <p className="mo-muted">
            Pair this browser with your MeetOps workspace to record and sync.
          </p>
          <button type="button" className="mo-btn mo-btn--primary" onClick={onPair}>
            Pair with MeetOps
          </button>
        </>
      )}
    </section>
  );
});

/** Compact pending-review count with a link to the web review page (opens in a new tab). */
export const PendingTasksRow = memo(function PendingTasksRow({
  pending,
  href,
}: {
  pending: PendingTasks;
  href: string;
}) {
  const label = pendingLabel(pending);
  return (
    <section className="mo-section mo-tasks" aria-label="Tasks to review">
      <span className="mo-tasks__count" role="status">
        {label}
      </span>
      <a
        className="mo-tasks__link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Review tasks in MeetOps (${label})`}
      >
        Review
      </a>
    </section>
  );
});

export interface RecorderViewProps {
  status: StatusPayload;
  consent: ConsentState;
  now: number;
  /** Primary when paired (the main action), secondary while pairing is still the next step. */
  emphasis: 'primary' | 'secondary';
  /** Pairing state, used for the unpaired start-blocked hint. Undefined while still asking the background. */
  paired?: boolean | undefined;
  /** A start attempt is in flight: Record stays disabled. */
  starting?: boolean;
  onConsentChange: (checked: boolean) => void;
  onRecord: () => void;
  onStop: () => void;
  onDismissWarning: () => void;
  /** Retry recordings held after a server refusal. */
  onRetryHeld?: () => void;
  /** Discard pressed: ask for confirmation (nothing is deleted yet). */
  onDiscardHeld?: () => void;
  /** The discard confirmation is showing. */
  discardConfirm?: boolean;
  onConfirmDiscard?: () => void;
  onCancelDiscard?: () => void;
}

interface HeldCalloutProps {
  count: number;
  closed: number;
  storageFull: boolean;
  confirm: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}

/** Recordings the server refused: retry (unless closed by the server) or discard after confirmation. */
function HeldCallout(h: HeldCalloutProps) {
  const terminal = h.closed > 0;
  return (
    <div
      className={`mo-callout ${terminal || h.storageFull ? 'mo-callout--error' : 'mo-callout--warning'}`}
      role="alert"
      aria-label="Upload held"
    >
      <p>{heldMessage({ count: h.count, closed: h.closed, storageFull: h.storageFull })}</p>
      {h.confirm ? (
        <div role="group" aria-label="Confirm discard">
          <p>{discardConfirmMessage(h.count)}</p>
          {h.onConfirm && (
            <button type="button" className="mo-btn mo-btn--secondary" onClick={h.onConfirm}>
              Discard recordings
            </button>
          )}
          {h.onCancel && (
            <button type="button" className="mo-btn mo-btn--ghost" onClick={h.onCancel}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <>
          {h.onRetry && h.count > h.closed && (
            <button type="button" className="mo-btn mo-btn--ghost" onClick={h.onRetry}>
              Retry upload
            </button>
          )}
          {h.onDiscard && (
            <button type="button" className="mo-btn mo-btn--ghost" onClick={h.onDiscard}>
              Discard
            </button>
          )}
        </>
      )}
    </div>
  );
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
      {(status.heldRecordings ?? 0) > 0 && (
        <HeldCallout
          count={status.heldRecordings ?? 0}
          closed={status.heldClosed ?? 0}
          storageFull={status.heldStorageFull === true}
          confirm={p.discardConfirm === true}
          {...(p.onRetryHeld ? { onRetry: p.onRetryHeld } : {})}
          {...(p.onDiscardHeld ? { onDiscard: p.onDiscardHeld } : {})}
          {...(p.onConfirmDiscard ? { onConfirm: p.onConfirmDiscard } : {})}
          {...(p.onCancelDiscard ? { onCancel: p.onCancelDiscard } : {})}
        />
      )}
      {!active && status.heldBlocksStart && (
        <p className="mo-hint" role="status" aria-label="Start blocked">
          {HELD_FULL_START_MESSAGE}
        </p>
      )}
      {!active && !status.heldBlocksStart && status.heldNearFull && (
        <p className="mo-hint" role="status" aria-label="Storage nearly full">
          {HELD_NEAR_FULL_MESSAGE}
        </p>
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
        <LiveStatus status={status} now={p.now} onStop={p.onStop} />
      ) : (
        <ConsentGate
          consent={consent}
          emphasis={p.emphasis}
          starting={p.starting ?? false}
          blocked={status.heldBlocksStart === true}
          onConsentChange={p.onConsentChange}
          onRecord={p.onRecord}
        />
      )}
      {p.paired === false && !active && status.status !== 'error' && (
        <p className="mo-hint" role="status" aria-label="Pairing required">
          {UNPAIRED_PROMPT_MESSAGE}
        </p>
      )}
    </section>
  );
}

/**
 * Consent gate in front of "Record this meeting" (contracts v0.4.1, G11). Record stays disabled until the user
 * ticks the confirmation. The tick is for this meeting only: the popup clears it after every start attempt.
 */
export const ConsentGate = memo(function ConsentGate(p: {
  consent: ConsentState;
  emphasis: 'primary' | 'secondary';
  starting: boolean;
  /** Held recordings fill local storage: Start is disabled. */
  blocked?: boolean;
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
        disabled={!confirmed || p.starting || p.blocked === true}
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
      {confirmed && (
        <p className="mo-consent__ok" role="status">
          <span aria-hidden="true">✓ </span>Consent confirmed for this meeting only.
        </p>
      )}
    </div>
  );
});

const STATE_LABEL: Record<'starting' | 'recording' | 'stopping', string> = {
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Saving…',
};

/**
 * Live recording status: state (announced politely), elapsed time and the contracts 4 h auto-stop. The ticking
 * timers are not live regions, so screen readers are not interrupted every second.
 */
export function LiveStatus({
  status,
  now,
  onStop,
}: {
  status: StatusPayload;
  now: number;
  onStop: () => void;
}) {
  const state = status.status as keyof typeof STATE_LABEL;
  const elapsed = status.startedAt !== undefined ? now - status.startedAt : undefined;
  const remaining = elapsed !== undefined ? Math.max(0, MAX_DURATION_MS - elapsed) : undefined;
  return (
    <div className={`mo-live mo-live--${state}`}>
      <p className="mo-live__line">
        {state === 'recording' ? (
          <span className="mo-live-dot" aria-hidden="true" />
        ) : (
          <span className="mo-spinner" aria-hidden="true" />
        )}
        <span className="mo-live__state" role="status">
          {STATE_LABEL[state]}
        </span>
        {elapsed !== undefined && (
          <span className="mo-mono" role="timer" aria-label="Elapsed">
            {formatElapsed(elapsed)}
          </span>
        )}
        <span className="mo-muted">· {status.chunks ?? 0} chunks</span>
      </p>
      {remaining !== undefined && state === 'recording' && (
        <p className="mo-hint">
          Stops automatically in <span className="mo-mono">{formatElapsed(remaining)}</span> (4 h
          limit).
        </p>
      )}
      <button
        type="button"
        className="mo-btn mo-btn--secondary"
        onClick={onStop}
        disabled={status.status === 'stopping'}
        aria-busy={status.status === 'stopping' || undefined}
      >
        Stop recording
      </button>
    </div>
  );
}

/** Non-field errors render as a toast pinned to the bottom of the popup. */
export const ErrorToast = memo(function ErrorToast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="mo-toast" role="alert">
      {message}
    </div>
  );
});

export interface PopupViewProps
  extends Omit<RecorderViewProps, 'emphasis' | 'paired'>, PairingViewProps {
  error: string;
  /** Pending-review count; shown only when paired and known. */
  pendingTasks?: PendingTasks | undefined;
  /** Web review page for the count link. */
  reviewHref?: string | undefined;
}

export function PopupView({
  error,
  auth,
  onPair,
  onUnpair,
  pendingTasks,
  reviewHref,
  ...recorder
}: PopupViewProps) {
  return (
    <PopupFrame>
      <BrandHeader auth={auth} />
      <hr className="mo-divider" />
      <PairingView auth={auth} onPair={onPair} onUnpair={onUnpair} />
      {auth?.state === 'paired' && pendingTasks && reviewHref ? (
        <PendingTasksRow pending={pendingTasks} href={reviewHref} />
      ) : null}
      <RecorderView
        {...recorder}
        paired={auth === undefined ? undefined : auth.state === 'paired'}
        emphasis={auth?.state === 'paired' ? 'primary' : 'secondary'}
      />
      <ErrorToast message={error} />
      <footer className="mo-privacy-footer">
        <PrivacyPolicyLink />
      </footer>
    </PopupFrame>
  );
}
