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
import { meetingValidators, uploadValidators, validators } from '../src/lib/auth/validate.js';
import {
  createMeetingResolver,
  isResolveMeetingMessage,
  type ResolveMeetingResult,
} from '../src/lib/meeting.js';
import { routeAlarm, WATCHDOG_ALARM } from '../src/lib/alarms.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { estimateQuota, requestPersistentStorage } from '../src/lib/storage-quota.js';
import {
  fetchPendingTasks,
  isPendingTasksRequest,
  type PendingTasksResponse,
} from '../src/lib/pending-tasks.js';
import { safeErrorMessage } from '../src/lib/redact.js';
import {
  discardHeldSessions,
  drainQueue,
  pendingStorage,
  summarizeHeld,
} from '../src/lib/drain.js';
import {
  isPendingDiscard,
  listFailedDiscards,
  retryPendingDiscards,
  withSessionGate,
} from '../src/lib/pending-discard.js';
import { classifySender, extensionUrls, mayUseAuthAndTaskReads } from '../src/lib/senders.js';
import { sessionKV } from '../src/lib/storage.js';
import { directUploadEnabled, httpUploadEnabled } from '../src/lib/features.js';
import { drainDirectUploads } from '../src/lib/direct-drain.js';
import { DirectUploadClient } from '../src/lib/upload-direct.js';
import { directUploadValidators } from '../src/lib/auth/validate.js';
import { HttpUploadClient } from '../src/lib/upload-http.js';
import { handleUploadRpc, isUploadRpcRequest } from '../src/lib/upload-rpc.js';
import {
  httpStorageTransport,
  pairedOrganizationId,
  selectUploadClient,
} from '../src/lib/upload-select.js';

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

/** Pending-task count for the popup; only when paired, scoped to the paired organization. */
async function handlePendingTasks(): Promise<PendingTasksResponse> {
  const s = await auth.status();
  if (s.state !== 'paired' || !s.organizationId) return { ok: false, error: 'not_paired' };
  return {
    ok: true,
    ...(await fetchPendingTasks((p, i) => auth.apiFetch(p, i), s.organizationId)),
  };
}

// Upload client. httpUploadEnabled() (on in development builds, off in production and in tests). When on,
// HttpUploadClient calls the recording-session API through auth.apiFetch() (bearer, exact API origin only) and
// PUTs chunks through the fetch transport (never a bearer). The offscreen recorder reaches it via UPLOAD_RPC
// messages (src/lib/upload-rpc.ts). When off, StubUploadClient makes no backend calls.
const HTTP_UPLOAD = httpUploadEnabled();
const client = selectUploadClient(
  HTTP_UPLOAD,
  () =>
    new HttpUploadClient({
      api: (path, init) => auth.apiFetch(path, init),
      organizationId: pairedOrganizationId(auth),
      storage: httpStorageTransport({ allowLocalHttp: import.meta.env.DEV }),
      validators: uploadValidators,
    }),
);
// WXT_FEATURE_DIRECT_UPLOAD (off by default, ignored when the chunked HTTP client is on): finished recordings are
// assembled from the local chunk store and sent as one file via POST /orgs/:org/uploads (src/lib/direct-drain.ts).
const DIRECT_UPLOAD = directUploadEnabled() && !HTTP_UPLOAD;
const direct = DIRECT_UPLOAD
  ? new DirectUploadClient({
      api: (path, init) => auth.apiFetch(path, init),
      organizationId: pairedOrganizationId(auth),
      storage: httpStorageTransport({ allowLocalHttp: import.meta.env.DEV }),
      ...directUploadValidators,
    })
  : undefined;
// Meeting for a new recording. HTTP uploads: find-or-create via the API from the tab URL (origin + path only).
// Stub uploads: a random UUID, as no meeting row is needed.
const resolveMeeting = createMeetingResolver({
  api: (path, init) => auth.apiFetch(path, init),
  organizationId: pairedOrganizationId(auth),
  validators: meetingValidators,
});
async function handleResolveMeeting(tabId: number): Promise<ResolveMeetingResult> {
  if (!HTTP_UPLOAD) return { ok: true, meetingId: crypto.randomUUID() };
  // activeTab: the popup click grants this tab's URL for the gesture; no host permissions needed.
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, meetingId: await resolveMeeting(tab.url) };
}

let storePromise: Promise<ChunkStore> | undefined;
// Ask Chrome to keep the recording queue persistent (not evicted under storage pressure). Best effort.
void requestPersistentStorage();
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

async function heldRecordings() {
  return summarizeHeld(await store());
}

async function syncHeldBadge(): Promise<void> {
  const { count } = await heldRecordings();
  const failed = (await listFailedDiscards(durableKV)).length;
  await chrome.action.setBadgeText({ text: count || failed ? '!' : '' }).catch(() => undefined);
}

/** Popup Retry upload: re-attempt sessions held after a 409/413 (kept locally, never aborted). */
async function retryHeld(): Promise<void> {
  await drainQueue(
    await store(),
    client,
    undefined,
    Date.now,
    { isMarked: (id) => isPendingDiscard(durableKV, id), gate: withSessionGate },
    { includeHeld: true },
  );
  await syncHeldBadge();
}

/** Popup Discard (confirmed): delete held recordings locally; the badge clears when nothing is left. */
async function discardHeld(): Promise<void> {
  await discardHeldSessions(await store(), client);
  await syncHeldBadge();
}

async function drain(): Promise<void> {
  try {
    await retryDiscards().catch((err: unknown) =>
      console.warn('MeetOps AI: retrying pending discards failed', err),
    );
    // Marked sessions are skipped (re-checked before each PUT and before complete, under a
    // per-session gate shared with marking); every other session still drains.
    const r = await drainQueue(await store(), client, undefined, Date.now, {
      isMarked: (id) => isPendingDiscard(durableKV, id),
      gate: withSessionGate,
    });
    if (r.held) await chrome.action.setBadgeText({ text: '!' }).catch(() => undefined);
    if (direct) {
      const { failed } = await drainDirectUploads(await store(), direct, {
        isMarked: (id) => isPendingDiscard(durableKV, id),
      });
      if (failed.length) console.warn(`MeetOps AI: ${failed.length} direct upload(s) will retry`);
    }
  } catch (err) {
    console.warn('MeetOps AI: draining queued chunks failed', err);
  }
}

const deps: BackgroundDeps = {
  heldRecordings,
  retryHeld,
  discardHeld,
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
      justification:
        'Record the tab audio, and the microphone when the user has already granted it in the popup, after consent.',
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
  // Fail closed (Start): any server-backed upload mode requires a verified pairing; errors refuse to record.
  // The local-only stub (no upload mode) has nothing to pair with, so it answers true explicitly.
  checkPairing:
    HTTP_UPLOAD || DIRECT_UPLOAD
      ? async () => {
          const st = await auth.status();
          return st.state === 'paired' && Boolean(st.organizationId);
        }
      : async () => true,
  pendingStorage: async () => pendingStorage(await store()),
  storageQuota: () => estimateQuota(),
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
    const sent = classifySender(sender, extensionUrls());
    const { fromSelf, fromOffscreen, fromPopup } = sent;
    if (isUploadRpcRequest(msg)) {
      // Only the offscreen recorder, and only when the HTTP client is enabled; anything else gets no response.
      if (!fromOffscreen || !HTTP_UPLOAD) return false;
      void handleUploadRpc(client, uploadValidators, msg).then(sendResponse);
      return true;
    }
    if (isAuthRequest(msg)) {
      if (!mayUseAuthAndTaskReads(sent)) return false; // popup or side panel
      handleAuth(msg).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: safeErrorMessage(err) }),
      );
      return true;
    }
    if (isResolveMeetingMessage(msg)) {
      if (!fromPopup) return false; // recording control is popup-only
      handleResolveMeeting(msg.tabId).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: safeErrorMessage(err) }),
      );
      return true;
    }
    if (isPendingTasksRequest(msg)) {
      if (!mayUseAuthAndTaskReads(sent)) return false; // popup or side panel
      handlePendingTasks().then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: safeErrorMessage(err) }),
      );
      return true;
    }
    // Recorder control (incl. starting a recording) stays popup-only: the side panel flag is never passed here.
    const done = handle(deps, msg, { fromSelf, fromOffscreen, fromPopup });
    // A finished recording is uploaded as one file as soon as it stops (direct-upload flag only).
    if (direct && fromOffscreen && (msg as { type?: string }).type === 'REC_STOPPED')
      void done.finally(() => void drain());
    done.then(sendResponse, (err: unknown) =>
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
