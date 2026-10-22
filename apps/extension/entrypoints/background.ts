/// <reference types="chrome" />
import {
  checkWatchdog,
  handleBackgroundMessage,
  serialized,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { drainQueue } from '../src/lib/drain.js';
import { retryPendingDiscards } from '../src/lib/pending-discard.js';
import { classifySender, extensionUrls } from '../src/lib/senders.js';
import { sessionKV } from '../src/lib/storage.js';
import { StubUploadClient } from '../src/lib/upload.js';

const OFFSCREEN_PATH = '/offscreen.html';
const WATCHDOG_ALARM = 'meetops-recorder-watchdog';

// TODO: swap for the real HTTP client once the chunked upload API exists.
const client = new StubUploadClient();
let storePromise: Promise<ChunkStore> | undefined;
const store = () => (storePromise ??= ChunkStore.open());

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

const durableKV = sessionKV(chrome.storage.local);

async function discardLocal(sessionId: string): Promise<void> {
  await (await store()).deleteSession(sessionId);
  // Abort is best effort for unknown/closed sessions; a real API answers 404/409 for those.
  await client.abort(sessionId, { reason: 'consent_revoked' }).catch(() => undefined);
}

async function drain(): Promise<void> {
  try {
    // Never upload a session marked for discard: finish those first, and hold the drain while
    // any remain (they are retried on the next worker start).
    const pending = await retryPendingDiscards(durableKV, discardLocal);
    if (pending.length) {
      console.warn('MeetOps AI: pending discards remain; not draining', pending);
      return;
    }
    await drainQueue(await store(), client);
  } catch (err) {
    console.warn('MeetOps AI: draining queued chunks failed', err);
  }
}

const deps: BackgroundDeps = {
  kv: sessionKV(),
  now: () => Date.now(),
  hasOffscreen,
  async capturedTabIds() {
    const tabs = await new Promise<chrome.tabCapture.CaptureInfo[]>((resolve) => {
      chrome.tabCapture.getCapturedTabs(resolve);
    });
    return tabs.filter((t) => t.status === 'active' || t.status === 'pending').map((t) => t.tabId);
  },
  async ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Record the tab audio the user explicitly chose to record, after consent.',
    });
  },
  async closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  },
  async sendToOffscreen(msg) {
    const res = await chrome.runtime.sendMessage<typeof msg, { ok: boolean; error?: string }>(msg);
    if (!res?.ok) throw new Error(res?.error ?? 'Offscreen document did not respond');
    return res;
  },
  async startWatchdog() {
    // 30 s is the minimum alarm period in Chrome 120+; alarms wake a suspended worker.
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  },
  async stopWatchdog() {
    await chrome.alarms.clear(WATCHDOG_ALARM);
  },
  async finalizeAfterCrash(sessionId, chunkCount, durationMs) {
    const s = await store();
    await s.finalizeSession(sessionId, { chunkCount, durationMs });
    await drain();
  },
  durableKV,
  discardLocal,
  async setBadge(text) {
    await chrome.action.setBadgeText({ text });
    if (text)
      await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#b45309' : '#c62828' });
  },
};

// One lock shared by message handling and the watchdog alarm, so state updates never interleave.
const locked = serialized(async (f: () => Promise<unknown>) => f());
const handle = (...a: Parameters<typeof handleBackgroundMessage>) =>
  locked(() => handleBackgroundMessage(...a)) as ReturnType<typeof handleBackgroundMessage>;

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if ((msg as { target?: string } | null)?.target !== 'background') return false;
    const { fromSelf, fromOffscreen, fromPopup } = classifySender(sender, extensionUrls());
    handle(deps, msg, { fromSelf, fromOffscreen, fromPopup }).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) void locked(() => checkWatchdog(deps));
  });

  // Retry queued chunks after a browser restart or extension install/update/reload.
  // onStartup is not guaranteed to reach a worker that registers late, so also drain whenever
  // the worker (re)starts; drainQueue is idempotent and skips already-uploaded chunks.
  // Pending discards run (under the state lock) before any drain, so a session marked for
  // discard is never uploaded; drain() also re-checks.
  const startup = () =>
    void locked(() => retryPendingDiscards(durableKV, discardLocal)).then(() => drain());
  chrome.runtime.onStartup.addListener(startup);
  chrome.runtime.onInstalled.addListener(startup);
  startup();
});
