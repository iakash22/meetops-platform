/// <reference types="chrome" />
import { useCallback, useEffect, useState } from 'react';
import {
  CONSENT_NOTICE,
  acknowledge,
  canStartRecording,
  initialConsent,
  showNotice,
  type ConsentState,
} from '../../src/lib/consent.js';
import type {
  BackgroundResponse,
  PopupToBackground,
  StatusPayload,
} from '../../src/lib/messages.js';
import { formatElapsed } from '../../src/lib/format.js';

const send = (msg: PopupToBackground): Promise<BackgroundResponse> =>
  chrome.runtime.sendMessage<PopupToBackground, BackgroundResponse>(msg);

const getStreamId = (targetTabId: number): Promise<string> =>
  new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? 'tabCapture failed'));
      else resolve(id);
    });
  });

const activeTabId = async (): Promise<number> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab');
  return tab.id;
};

export function App() {
  const [consent, setConsent] = useState<ConsentState>(initialConsent());
  const [status, setStatus] = useState<StatusPayload>({ status: 'idle' });
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const apply = useCallback((res: BackgroundResponse) => {
    if (res.ok) {
      setStatus(res);
      setError(res.lastError ?? '');
    } else setError(res.error);
  }, []);

  const refresh = useCallback(() => {
    send({ target: 'background', type: 'GET_STATUS' }).then(apply, (e: unknown) =>
      setError(String(e)),
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

  const onAcknowledge = async () => {
    try {
      const tabId = await activeTabId();
      apply(await send({ target: 'background', type: 'ACK_CONSENT', tabId }));
      setConsent(acknowledge(consent));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Runs directly from the click so tabCapture stays inside the user gesture.
  const onStart = async () => {
    if (!canStartRecording(consent)) return;
    try {
      const tabId = await activeTabId();
      const streamId = await getStreamId(tabId);
      apply(await send({ target: 'background', type: 'START_RECORDING', tabId, streamId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConsent(initialConsent());
    }
  };

  const onStop = async () => {
    apply(await send({ target: 'background', type: 'STOP_RECORDING' }));
  };

  const active = status.status !== 'idle';

  return (
    <main style={{ width: 320, padding: 12, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 16 }}>MeetOps AI</h1>
      <section>
        <p>Not signed in.</p>
        <button type="button" disabled title="Sign-in coming soon">
          Sign in
        </button>
      </section>
      <hr />
      {active ? (
        <section aria-live="polite">
          <p>
            ● {status.status === 'recording' ? 'Recording' : status.status}{' '}
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
        <>
          {consent.status === 'unseen' && (
            <button type="button" onClick={() => setConsent(showNotice(consent))}>
              Record this meeting
            </button>
          )}
          {consent.status === 'shown' && (
            <section role="alertdialog" aria-label="Recording consent">
              <p>{CONSENT_NOTICE}</p>
              <button type="button" onClick={() => void onAcknowledge()}>
                I understand and have consent
              </button>
              <button type="button" onClick={() => setConsent(initialConsent())}>
                Cancel
              </button>
            </section>
          )}
          {consent.status === 'acknowledged' && (
            <button type="button" onClick={() => void onStart()}>
              Start recording
            </button>
          )}
        </>
      )}
      {error && <p role="alert">Error: {error}</p>}
    </main>
  );
}
