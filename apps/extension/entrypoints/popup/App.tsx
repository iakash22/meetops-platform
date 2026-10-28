/// <reference types="chrome" />
import {
  resolveMeetingId,
  type ResolveMeetingMessage,
  type ResolveMeetingResult,
} from '../../src/lib/meeting.js';
import { useCallback, useEffect, useState } from 'react';
import {
  canStartRecording,
  consentGrant,
  initialConsent,
  setConfirmed,
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
import { usePendingTasks } from './usePendingTasks.js';
import { authConfig } from '../../src/lib/auth/config.js';
import { reviewUrl } from '../../src/lib/pending-tasks.js';

const REVIEW_HREF = reviewUrl(authConfig().webOrigin);

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
  const [starting, setStarting] = useState(false);
  const { error: pairingError, ...pairing } = usePairing();
  const pendingTasks = usePendingTasks(pairing.auth);

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

  // Runs directly from the click so tabCapture stays inside the user gesture. The ticked confirmation is sent to the
  // background for this tab + meeting first (ACK_CONSENT), then consumed by START_RECORDING.
  const onRecord = async () => {
    if (!canStartRecording(consent) || starting) return;
    setStarting(true);
    try {
      const tabId = await activeTabId();
      const streamId = await getTabStreamId(tabId);
      const meetingId = await resolveMeetingId(tabId, (m: ResolveMeetingMessage) =>
        chrome.runtime.sendMessage<ResolveMeetingMessage, ResolveMeetingResult>(m),
      );
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
      setRawError(errText(e));
    } finally {
      // Per meeting, per recording: never carried over to the next start.
      setConsent(initialConsent());
      setStarting(false);
    }
  };

  // Stable callbacks so the memoised header, pairing and consent views skip the 1 s timer re-render.
  const onStop = useCallback(() => {
    send({ target: 'background', type: 'STOP_RECORDING' }).then(apply, (e: unknown) =>
      setRawError(errText(e)),
    );
  }, [apply]);
  const onConsentChange = useCallback((checked: boolean) => setConsent(setConfirmed(checked)), []);

  const onDismissWarning = useCallback(() => {
    send({ target: 'background', type: 'DISMISS_WARNING' }).then(apply, (e: unknown) =>
      setRawError(errText(e)),
    );
  }, [apply]);

  return (
    <PopupView
      {...pairing}
      pendingTasks={pendingTasks}
      reviewHref={REVIEW_HREF}
      status={status}
      consent={consent}
      now={now}
      error={popupErrorMessage(rawError, true) || popupErrorMessage(pairingError, true)}
      starting={starting}
      onConsentChange={onConsentChange}
      onRecord={() => void onRecord()}
      onStop={onStop}
      onDismissWarning={onDismissWarning}
    />
  );
}
