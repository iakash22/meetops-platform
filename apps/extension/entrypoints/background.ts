/// <reference types="chrome" />
import {
  checkWatchdog,
  handleBackgroundMessage,
  serialized,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { AuthService, NONCE_ALARM } from '../src/lib/auth/auth-service.js';
import { authConfig } from '../src/lib/auth/config.js';
import { isAuthRequest, type AuthRequest, type AuthResponse } from '../src/lib/auth/messages.js';
import { validators } from '../src/lib/auth/validate.js';
import { routeAlarm, WATCHDOG_ALARM } from '../src/lib/alarms.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { safeErrorMessage } from '../src/lib/redact.js';
import { drainQueue } from '../src/lib/drain.js';
import {
  isPendingDiscard,
  listFailedDiscards,
  retryPendingDiscards,
  withSessionGate,
} from '../src/lib/pending-discard.js';
import { classifySender, extensionUrls } from '../src/lib/senders.js';
import { sessionKV } from '../src/lib/storage.js';
import { StubUploadClient } from '../src/lib/upload.js';

const OFFSCREEN_PATH = '/offscreen.html';

// ADR-005 pairing. Tokens live only in chrome.storage.session (access level left at the default TRUSTED_CONTEXTS).
const auth = new AuthService({
  session: sessionKV(),
  install: sessionKV(chrome.storage.local), // deviceId only (not a secret); tokens never go here
  config: authConfig(),
  extensionId: chrome.runtime.id,
  now: () => Date.now(),
  fetch: (url, init) => fetch(url, init),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  randomUUID: () => crypto.randomUUID(),
  async openTab(url) {
    await chrome.tabs.create({ url });
  },
  validators,
  alarms: {
    async schedule(when) {
      await chrome.alarms.create(NONCE_ALARM, { when });
    },
    async clear() {
      await chrome.alarms.clear(NONCE_ALARM);
    },
  },
});

async function handleAuth(msg: AuthRequest): Promise<AuthResponse> {
  if (msg.type === 'AUTH_PAIR') await auth.startPairing();
  if (msg.type === 'AUTH_UNPAIR') await auth.unpair();
  return { ok: true, ...(await auth.status()) };
}

// TODO: swap for the real HTTP client once the chunked upload API exists. The uploader stays a stub: no backend
// calls are enabled by default. A real client must use auth.apiFetch() for API routes (bearer, API origin only)
// and createFetchTransport() for presigned PUTs (never a bearer).
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

async function deleteLocal(sessionId: string): Promise<void> {
  await (await store()).deleteSession(sessionId);
}

/** Retry pending discards; a session that can never be deleted shows the '!' badge. */
async function retryDiscards(): Promise<void> {
  await retryPendingDiscards(durableKV, discardLocal, deleteLocal, (id) =>
    client.abort(id, { reason: 'consent_revoked' }),
  );
  if ((await listFailedDiscards(durableKV)).length) {
    await chrome.action.setBadgeText({ text: '!' }).catch(() => undefined);
  }
}

async function drain(): Promise<void> {
  try {
    await retryDiscards().catch((err: unknown) =>
      console.warn('MeetOps AI: retrying pending discards failed', err),
    );
    // Marked sessions are skipped (re-checked before each PUT and before complete, under a
    // per-session gate shared with marking); every other session still drains.
    await drainQueue(await store(), client, undefined, Date.now, {
      isMarked: (id) => isPendingDiscard(durableKV, id),
      gate: withSessionGate,
    });
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
  deleteLocal,
  async setBadge(text) {
    // An undeletable discarded session keeps the error badge until it is resolved.
    if (!text && (await listFailedDiscards(durableKV).catch(() => [])).length) text = '!';
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
    if (isAuthRequest(msg)) {
      if (!fromPopup) return false;
      handleAuth(msg).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: safeErrorMessage(err) }),
      );
      return true;
    }
    handle(deps, msg, { fromSelf, fromOffscreen, fromPopup }).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });

  // Pairing handoff from the web app (ADR-005 A1.1.4): exact origin check + schema + nonce, else dropped silently.
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (!auth.acceptsOrigin(sender)) return false; // no response at all to other origins
    auth.handleExternalMessage(msg, sender).then(
      (ok) => sendResponse({ ok }),
      () => sendResponse({ ok: false }),
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    routeAlarm(alarm.name, {
      watchdog: () => void locked(() => checkWatchdog(deps)),
      nonceExpiry: () => void auth.onNonceAlarm(),
    });
  });

  // Retry queued chunks after a browser restart or extension install/update/reload.
  // onStartup is not guaranteed to reach a worker that registers late, so also drain whenever
  // the worker (re)starts; drainQueue is idempotent and skips already-uploaded chunks.
  // Pending discards run (under the state lock) before any drain, so a session marked for
  // discard is never uploaded; drain() also re-checks.
  const startup = () =>
    void locked(() => retryDiscards()).then(
      () => drain(),
      () => drain(),
    );
  chrome.runtime.onStartup.addListener(startup);
  chrome.runtime.onInstalled.addListener(startup);
  startup();
});
