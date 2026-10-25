/// <reference types="chrome" />
import { resolveMeetingId } from '../../src/lib/meeting.js';
import { useCallback, useEffect, useState } from 'react';
import {
  canStartRecording,
  consentGrant,
  initialConsent,
  setConfirmed,
  type ConsentState,
} from '../../src/lib/consent.js';
import { formatElapsed } from '../../src/lib/format.js';
import type {
  BackgroundResponse,
  PopupToBackground,
  StatusPayload,
} from '../../src/lib/messages.js';
import { getTabStreamId } from '../../src/lib/tab-capture.js';
import { ConsentSection } from './ConsentSection.js';
import { PairingSection } from './PairingSection.js';

const send = (msg: PopupToBackground): Promise<BackgroundResponse> =>
  chrome.runtime.sendMessage<PopupToBackground, BackgroundResponse>(msg);

const activeTabId = async (): Promise<number> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab');
  return tab.id;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [consent, setConsent] = useState<ConsentState>(initialConsent());
  const [status, setStatus] = useState<StatusPayload>({ status: 'idle' });
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);

  const apply = useCallback((res: BackgroundResponse) => {
    if (res.ok) {
      setStatus(res);
      setError(res.status === 'error' ? '' : (res.lastError ?? ''));
    } else setError(res.error);
  }, []);

  const refresh = useCallback(() => {
    send({ target: 'background', type: 'GET_STATUS' }).then(apply, (e: unknown) =>
      setError(errText(e)),
    );
  }, [apply]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  // Runs directly from the click so tabCapture stays inside the user gesture. The ticked confirmation is sent to the
  // background for this tab + meeting first (ACK_CONSENT), then consumed by START_RECORDING.
  const onRecord = async () => {
    if (!canStartRecording(consent) || starting) return;
    setStarting(true);
    try {
      const tabId = await activeTabId();
      const streamId = await getTabStreamId(tabId);
      const meetingId = await resolveMeetingId();
      const ack = await send({
        target: 'background',
        type: 'ACK_CONSENT',
        tabId,
        ...consentGrant(consent, meetingId),
      });
      if (!ack.ok) {
        apply(ack);
        return;
      }
      apply(
        await send({ target: 'background', type: 'START_RECORDING', tabId, streamId, meetingId }),
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      // Per meeting, per recording: never carried over to the next start.
      setConsent(initialConsent());
      setStarting(false);
    }
  };

  const onStop = async () => {
    apply(await send({ target: 'background', type: 'STOP_RECORDING' }));
  };

  const onDismissWarning = async () => {
    apply(await send({ target: 'background', type: 'DISMISS_WARNING' }));
  };

  const active =
    status.status === 'starting' || status.status === 'recording' || status.status === 'stopping';

  return (
    <main style={{ width: 320, padding: 12, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 16 }}>MeetOps AI</h1>
      <PairingSection />
      <hr />
      {status.incomplete && (
        <section role="alert" aria-label="Incomplete recording">
          <p>
            <strong>Recording incomplete.</strong> Some audio was lost because local storage was
            full, so this recording will be discarded instead of submitted.
          </p>
        </section>
      )}
      {status.storageWarning && (
        <section role="alert" aria-label="Storage warning">
          <p>⚠ {status.storageWarning}</p>
          <button type="button" onClick={() => void onDismissWarning()}>
            Dismiss
          </button>
        </section>
      )}
      {status.status === 'error' ? (
        <section role="alert" aria-label="Recording error">
          <p>{status.lastError ?? 'Recording stopped unexpectedly.'}</p>
          <button type="button" onClick={() => void onStop()}>
            Dismiss
          </button>
        </section>
      ) : active ? (
        <section aria-live="polite">
          <p>
            <span className="mo-live-dot" aria-hidden="true">
              ●
            </span>{' '}
            {status.status === 'recording' ? 'Recording' : status.status}{' '}
            {status.startedAt !== undefined && formatElapsed(now - status.startedAt)} ·{' '}
            {status.chunks ?? 0} chunks
          </p>
          <button
            type="button"
            onClick={() => void onStop()}
            disabled={status.status === 'stopping'}
          >
            Stop recording
          </button>
        </section>
      ) : (
        <ConsentSection
          consent={consent}
          busy={starting}
          onConfirmedChange={(checked) => setConsent(setConfirmed(checked))}
          onRecord={() => void onRecord()}
        />
      )}
      {error && <p role="alert">Error: {error}</p>}
    </main>
  );
}
