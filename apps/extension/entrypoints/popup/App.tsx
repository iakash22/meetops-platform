import { useState } from "react";
import {
  CONSENT_NOTICE,
  acknowledge,
  canStartRecording,
  initialConsent,
  showNotice,
  type ConsentState
} from "../../src/lib/consent";
import type { BackgroundResponse, PopupToBackground } from "../../src/lib/messages";

const send = (msg: PopupToBackground): Promise<BackgroundResponse> =>
  chrome.runtime.sendMessage<PopupToBackground, BackgroundResponse>(msg);

const getStreamId = (targetTabId: number): Promise<string> =>
  new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? "tabCapture failed"));
      else resolve(id);
    });
  });

export function App() {
  const [consent, setConsent] = useState<ConsentState>(initialConsent());
  const [message, setMessage] = useState<string>("");

  // Called directly from the button click so tabCapture runs inside a user gesture.
  const startRecording = async () => {
    if (!canStartRecording(consent) || consent.status !== "acknowledged") return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("No active tab");
      const streamId = await getStreamId(tab.id);
      const res = await send({
        type: "START_RECORDING",
        tabId: tab.id,
        streamId,
        consentAcknowledgedAt: consent.acknowledgedAt
      });
      setMessage(res.ok ? `Status: ${res.status}` : `Error: ${res.error}`);
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <main style={{ width: 320, padding: 12, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 16 }}>MeetOps</h1>
      <section>
        <p>Not signed in.</p>
        <button type="button" disabled title="Sign-in coming soon">
          Sign in
        </button>
      </section>
      <hr />
      {consent.status === "unseen" && (
        <button type="button" onClick={() => setConsent(showNotice(consent))}>
          Record this meeting
        </button>
      )}
      {consent.status === "shown" && (
        <section role="alertdialog" aria-label="Recording consent">
          <p>{CONSENT_NOTICE}</p>
          <button type="button" onClick={() => setConsent(acknowledge(consent))}>
            I understand and have consent
          </button>
          <button type="button" onClick={() => setConsent(initialConsent())}>
            Cancel
          </button>
        </section>
      )}
      {consent.status === "acknowledged" && (
        <button type="button" onClick={() => void startRecording()}>
          Start recording
        </button>
      )}
      {message && <p>{message}</p>}
    </main>
  );
}
