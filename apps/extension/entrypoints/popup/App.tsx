/// <reference types="chrome" />
import { resolveMeetingId } from '../../src/lib/meeting.js';
import { useCallback, useEffect, useState } from 'react';
import {
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
import { getTabStreamId } from '../../src/lib/tab-capture.js';
import { detectPopupContext, popupErrorMessage, type PopupContext } from './popup-errors.js';
import { OpenFromToolbar, PopupFrame, BrandHeader, PopupView } from './PopupView.js';
import { usePairing } from './usePairing.js';

const send = (msg: PopupToBackground): Promise<BackgroundResponse> =>
  chrome.runtime.sendMessage<PopupToBackground, BackgroundResponse>(msg);

const activeTabId = async (): Promise<number> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab');
  return tab.id;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [context, setContext] = useState<PopupContext>('checking');
  useEffect(() => {
    void detectPopupContext().then(setContext);
  }, []);

  // Outside the action popup the background refuses every command, so do not even ask it.
  if (context === 'tab') return <OpenFromToolbar />;
  if (context === 'checking')
    return (
      <PopupFrame>
        <BrandHeader />
      </PopupFrame>
    );
  return <PopupApp />;
}

function PopupApp() {
  const [consent, setConsent] = useState<ConsentState>(initialConsent());
  const [status, setStatus] = useState<StatusPayload>({ status: 'idle' });
  const [rawError, setRawError] = useState('');
  const [now, setNow] = useState(Date.now());
  const { error: pairingError, ...pairing } = usePairing();

  const apply = useCallback((res: BackgroundResponse) => {
    if (res.ok) {
      setStatus(res);
      setRawError(res.status === 'error' ? '' : (res.lastError ?? ''));
    } else setRawError(res.error);
  }, []);

  const refresh = useCallback(() => {
    send({ target: 'background', type: 'GET_STATUS' }).then(apply, (e: unknown) =>
      setRawError(errText(e)),
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
      setRawError(errText(e));
    }
  };

  // Runs directly from the click so tabCapture stays inside the user gesture.
  const onStart = async () => {
    if (!canStartRecording(consent)) return;
    try {
      const tabId = await activeTabId();
      const streamId = await getTabStreamId(tabId);
      const meetingId = await resolveMeetingId();
      apply(
        await send({ target: 'background', type: 'START_RECORDING', tabId, streamId, meetingId }),
      );
    } catch (e) {
      setRawError(errText(e));
    } finally {
      setConsent(initialConsent());
    }
  };

  const onStop = async () => {
    apply(await send({ target: 'background', type: 'STOP_RECORDING' }));
  };

  const onDismissWarning = async () => {
    apply(await send({ target: 'background', type: 'DISMISS_WARNING' }));
  };

  return (
    <PopupView
      {...pairing}
      status={status}
      consent={consent}
      now={now}
      error={popupErrorMessage(rawError, true) || popupErrorMessage(pairingError, true)}
      onRecord={() => setConsent(showNotice(consent))}
      onAcknowledge={() => void onAcknowledge()}
      onCancelConsent={() => setConsent(initialConsent())}
      onStart={() => void onStart()}
      onStop={() => void onStop()}
      onDismissWarning={() => void onDismissWarning()}
    />
  );
}
