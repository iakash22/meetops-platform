/// <reference types="chrome" />
import {
  checkWatchdog,
  handleBackgroundMessage,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { drainQueue } from '../src/lib/drain.js';
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

async function drain(): Promise<void> {
  try {
    await drainQueue(await store(), client);
  } catch (err) {
    console.warn('MeetOps AI: draining queued chunks failed', err);
  }
}

const deps: BackgroundDeps = {
  kv: sessionKV(),
  now: () => Date.now(),
  hasOffscreen,
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
  async setBadge(text) {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  },
};

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if ((msg as { target?: string } | null)?.target !== 'background') return false;
    const fromSelf = sender.id === chrome.runtime.id;
    const fromOffscreen = fromSelf && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
    handleBackgroundMessage(deps, msg, { fromSelf, fromOffscreen }).then(
      sendResponse,
      (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) void checkWatchdog(deps);
  });

  // Retry queued chunks after a browser restart or extension install/update/reload.
  // onStartup is not guaranteed to reach a worker that registers late, so also drain whenever
  // the worker (re)starts; drainQueue is idempotent and skips already-uploaded chunks.
  chrome.runtime.onStartup.addListener(() => void drain());
  chrome.runtime.onInstalled.addListener(() => void drain());
  void drain();
});
