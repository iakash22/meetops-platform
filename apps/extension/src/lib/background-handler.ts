import {
  HELD_FULL_START_MESSAGE,
  PENDING_CHECK_FAILED_MESSAGE,
  PENDING_FULL_START_MESSAGE,
  heldStorageLevel,
  pendingStorageFull,
  type HeldSummary,
  type PendingStorage,
} from './drain.js';
import {
  addPendingDiscard,
  clearPendingDiscard,
  DISCARD_FAILED_MESSAGE,
  listFailedDiscards,
  retryPendingDiscards,
} from './pending-discard.js';
import {
  QUOTA_CHECK_FAILED_MESSAGE,
  QUOTA_FULL_START_MESSAGE,
  QUOTA_LOW_MESSAGE,
  quotaLevel,
  type QuotaEstimate,
  type QuotaLevel,
} from './storage-quota.js';
import { consumeConsent, recordConsent, toAttestation } from './consent-registry.js';
import {
  isBackgroundMessage,
  type BackgroundResponse,
  type BackgroundToOffscreen,
  type StorageEvent,
} from './messages.js';
import { loadState, saveState, type RecorderState } from './recorder-state.js';
import type { KV } from './storage.js';

/** No heartbeat for this long while active => the offscreen recorder is considered dead. */
export const HEARTBEAT_TIMEOUT_MS = 20_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface BackgroundDeps {
  kv: KV;
  now: () => number;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  hasOffscreen: () => Promise<boolean>;
  sendToOffscreen: (msg: BackgroundToOffscreen) => Promise<unknown>;
  /** Start/stop the periodic watchdog (chrome.alarms; survives SW suspension). */
  startWatchdog: () => Promise<void>;
  stopWatchdog: () => Promise<void>;
  /** Mark a crashed session finalized in the chunk queue and drain it. */
  finalizeAfterCrash: (sessionId: string, chunkCount: number, durationMs: number) => Promise<void>;
  /** Tab ids Chrome reports as being tab-captured (chrome.tabCapture.getCapturedTabs). */
  capturedTabIds: () => Promise<number[]>;
  /** Toolbar badge: 'REC' while recording, '' when idle. */
  setBadge: (text: string) => Promise<void>;
  /** Persistent storage (chrome.storage.local) for pending-discard markers. */
  durableKV: KV;
  /**
   * Delete a session and its chunks from IndexedDB directly (no offscreen doc needed) and abort
   * its upload session with 'consent_revoked'. Must be idempotent.
   */
  discardLocal: (sessionId: string) => Promise<void>;
  /** Fallback after repeated discard failures: delete the session from IndexedDB only. */
  deleteLocal?: (sessionId: string) => Promise<void>;
  /**
   * Number of recordings held after a server refusal (409/413); surfaced in the popup. Required: Start fails closed
   * on it, so a missing implementation must be a type error, not a silently skipped check.
   */
  heldRecordings: () => Promise<HeldSummary>;
  /** Retry the held recordings (popup Retry upload). */
  retryHeld?: () => Promise<void>;
  /** Delete the held recordings locally (popup Discard, after confirmation). */
  discardHeld?: () => Promise<void>;
  /**
   * Pairing check for Start (ADR-005). Resolves true only when the extension is paired. A false result or a
   * throw blocks Start (fail closed).
   */
  checkPairing: () => Promise<boolean>;
  /** Browser storage usage/quota (navigator.storage.estimate). A throw blocks Start (fail closed). */
  storageQuota: () => Promise<QuotaEstimate>;
  /**
   * Bytes of ALL not-yet-uploaded chunks (held or merely queued) and the local cap. Pending chunks are never
   * evicted, so Start needs one full chunk of room on top of them. A throw blocks Start (fail closed).
   */
  pendingStorage: () => Promise<PendingStorage>;
  /** Override OFFSCREEN_TIMEOUT_MS (tests). */
  offscreenTimeoutMs?: number;
}

/** Max wait for the offscreen document to answer, so a hung getUserMedia can't hold the SW lock. */
export const OFFSCREEN_TIMEOUT_MS = 10_000;

function sendOffscreen(deps: BackgroundDeps, msg: BackgroundToOffscreen): Promise<unknown> {
  const ms = deps.offscreenTimeoutMs ?? OFFSCREEN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Offscreen recorder did not respond within ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([deps.sendToOffscreen(msg), timeout]).finally(() => clearTimeout(timer));
}

export interface SenderInfo {
  /** True when the message came from this extension's own pages. */
  fromSelf: boolean;
  /** True when sent from the offscreen document. */
  fromOffscreen: boolean;
  /** True when sent from the action popup page. */
  fromPopup: boolean;
}

const extras = (s: RecorderState) => ({
  ...(s.lastError ? { lastError: s.lastError } : {}),
  ...(s.storageWarning ? { storageWarning: s.storageWarning } : {}),
  ...(s.incomplete ? { incomplete: true } : {}),
});

/**
 * Serialise all message handling so read-modify-write of session state (and consent
 * consumption) cannot interleave across concurrent messages.
 */
export function serialized<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  let tail: Promise<unknown> = Promise.resolve();
  return (...a: A): Promise<R> => {
    const run = tail.then(() => fn(...a));
    tail = run.catch(() => undefined);
    return run;
  };
}

const USED_STREAMS_KEY = 'usedStreamIds';

const status = (s: RecorderState): BackgroundResponse =>
  s.status === 'idle'
    ? { ok: true, status: 'idle', ...extras(s) }
    : {
        ok: true,
        status: s.status,
        tabId: s.tabId,
        startedAt: s.startedAt,
        chunks: s.chunks,
        ...extras(s),
      };

const fail = (error: string): BackgroundResponse => ({ ok: false, error });

export const PAIRING_REQUIRED_MESSAGE =
  'This browser is not paired with MeetOps AI, so recording was not started. Pair the extension first.';
export const PAIRING_CHECK_FAILED_MESSAGE =
  'Could not verify that this browser is paired with MeetOps AI, so recording was not started. Try again.';
export const CONSENT_CHECK_FAILED_MESSAGE =
  'Could not verify recording consent, so recording was not started. Confirm consent and try again.';

export const HELD_CHECK_FAILED_MESSAGE =
  'Could not check local storage for held recordings, so recording was not started. Try again.';

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function describeStorageEvent(e: StorageEvent): string {
  if (e.kind === 'refused') {
    return `Local storage limit reached: chunk #${e.seq} was not saved. This recording is incomplete and will not be submitted.`;
  }
  return e.lostPending > 0
    ? `Local storage limit reached: ${e.lostPending} chunk(s) not yet uploaded were deleted (${mb(e.bytes)} freed). This recording is incomplete and will not be submitted.`
    : `Local storage limit reached: ${e.count} already-uploaded chunk(s) (${mb(e.bytes)}) were removed from local storage.`;
}

/**
 * Watchdog: if active and the offscreen doc is gone or silent, move to 'error', finalize the
 * session so its queued chunks are uploaded later, and notify the user via the badge.
 * The tab stream cannot be re-acquired without a new user gesture, so no auto-restart.
 */
export async function checkWatchdog(deps: BackgroundDeps): Promise<RecorderState> {
  const state = await loadState(deps.kv);
  if (state.status === 'idle' || state.status === 'error') return state;
  const silentFor = deps.now() - state.lastHeartbeatAt;
  const alive = silentFor <= HEARTBEAT_TIMEOUT_MS && (await deps.hasOffscreen());
  if (alive) return state;
  const next: RecorderState = {
    ...state,
    status: 'error',
    lastError:
      'Recording stopped unexpectedly (recorder not responding). Audio captured so far is kept and will be uploaded.',
  };
  await saveState(deps.kv, next);
  await deps.stopWatchdog().catch(() => undefined);
  await deps.closeOffscreen().catch(() => undefined);
  if (state.sessionId) {
    await deps
      .finalizeAfterCrash(state.sessionId, state.chunks, deps.now() - state.startedAt)
      .catch(() => undefined);
  }
  await deps.setBadge('!').catch(() => undefined);
  return next;
}

async function toIdle(deps: BackgroundDeps, prev: RecorderState, lastError?: string) {
  const next: RecorderState = {
    status: 'idle',
    ...(lastError ? { lastError } : {}),
    ...(prev.storageWarning ? { storageWarning: prev.storageWarning } : {}),
    ...(prev.incomplete ? { incomplete: true } : {}),
  };
  await saveState(deps.kv, next);
  await deps.stopWatchdog().catch(() => undefined);
  await deps.closeOffscreen().catch(() => undefined);
  await deps.setBadge(lastError ? '!' : '').catch(() => undefined);
  return next;
}

/**
 * Adds the held-recordings summary to a status answer and keeps the toolbar badge in sync: '!' while anything is
 * held, cleared once nothing is held and nothing else needs attention (idle, no error, no failed discard).
 */
async function withHeld(
  deps: BackgroundDeps,
  state: RecorderState,
  r: BackgroundResponse,
  otherAlert: boolean,
): Promise<BackgroundResponse> {
  if (!r.ok) return r;
  const h = await deps.heldRecordings().catch(() => undefined);
  if (!h) return r;
  if (state.status === 'idle') {
    const alert = h.count > 0 || otherAlert || Boolean(state.lastError);
    await deps.setBadge(alert ? '!' : '').catch(() => undefined);
  }
  if (h.count === 0) return r;
  const level = heldStorageLevel(h);
  return {
    ...r,
    heldRecordings: h.count,
    ...(h.closed ? { heldClosed: h.closed } : {}),
    ...(state.storageWarning || level === 'full' ? { heldStorageFull: true } : {}),
    ...(level === 'near-full' ? { heldNearFull: true } : {}),
    ...(level === 'full' ? { heldBlocksStart: true } : {}),
  };
}

export async function handleBackgroundMessage(
  deps: BackgroundDeps,
  msg: unknown,
  sender: SenderInfo,
): Promise<BackgroundResponse> {
  if (!sender.fromSelf) return fail('Untrusted sender');
  if (!isBackgroundMessage(msg)) return fail('Unknown or malformed message');
  const { kv } = deps;

  const isEvent = msg.type.startsWith('REC_');
  if (isEvent && !sender.fromOffscreen)
    return fail('Recorder events must come from the offscreen document');
  if (!isEvent && !sender.fromPopup) return fail('Commands must come from the popup');

  // Popup commands run the watchdog first so a dead recorder is reported promptly.
  const state = isEvent ? await loadState(kv) : await checkWatchdog(deps);

  switch (msg.type) {
    case 'GET_STATUS': {
      // A discard that could not be completed is surfaced until the user clears extension data.
      const failed = await listFailedDiscards(deps.durableKV).catch(() => [] as string[]);
      if (failed.length && state.status === 'idle') {
        const lastError = state.lastError
          ? `${state.lastError} ${DISCARD_FAILED_MESSAGE}`
          : DISCARD_FAILED_MESSAGE;
        return withHeld(deps, state, status({ ...state, lastError }), true);
      }
      return withHeld(deps, state, status(state), false);
    }

    case 'RETRY_HELD_UPLOADS': {
      if (!deps.retryHeld) return fail('Retry is not available');
      await deps.retryHeld().catch(() => undefined);
      return withHeld(deps, state, status(state), false);
    }

    case 'DISCARD_HELD_UPLOADS': {
      if (!deps.discardHeld) return fail('Discard is not available');
      await deps.discardHeld().catch(() => undefined);
      return withHeld(deps, state, status(state), false);
    }

    case 'DISMISS_WARNING': {
      const next = { ...state };
      delete next.storageWarning;
      if (next.status === 'idle') delete next.incomplete;
      await saveState(kv, next);
      return status(next);
    }

    case 'ACK_CONSENT':
      await recordConsent(kv, msg.tabId, deps.now(), {
        meetingId: msg.meetingId,
        method: msg.method,
      });
      return status(state);

    case 'START_RECORDING': {
      if (state.status !== 'idle' && state.status !== 'error') return fail('Already recording');
      // Fail closed: every check below is mandatory; a missing answer, a throw or a non-true value refuses Start.
      let paired: boolean;
      try {
        paired = (await deps.checkPairing()) === true;
      } catch {
        return fail(PAIRING_CHECK_FAILED_MESSAGE);
      }
      if (!paired) return fail(PAIRING_REQUIRED_MESSAGE);
      // Held recordings (server-refused) block Start with their own message so the popup can offer Retry/Discard.
      let held: HeldSummary;
      try {
        held = await deps.heldRecordings();
      } catch {
        return fail(HELD_CHECK_FAILED_MESSAGE);
      }
      if (heldStorageLevel(held) === 'full') return fail(HELD_FULL_START_MESSAGE);
      // Pending chunks (held or still queued) are never evicted: without room for one more chunk the very first
      // chunk of the new recording would be refused, so do not start.
      try {
        if (pendingStorageFull(await deps.pendingStorage()))
          return fail(PENDING_FULL_START_MESSAGE);
      } catch {
        return fail(PENDING_CHECK_FAILED_MESSAGE);
      }
      let quotaWarning: string | undefined;
      let level: QuotaLevel;
      try {
        level = quotaLevel(await deps.storageQuota());
      } catch {
        return fail(QUOTA_CHECK_FAILED_MESSAGE);
      }
      if (level === 'full') return fail(QUOTA_FULL_START_MESSAGE);
      if (level === 'low') quotaWarning = QUOTA_LOW_MESSAGE;
      let used: string[];
      let consent: Awaited<ReturnType<typeof consumeConsent>>;
      try {
        used = (await kv.get<string[]>(USED_STREAMS_KEY)) ?? [];
        if (used.includes(msg.streamId)) return fail('Stream id already used');
        consent = await consumeConsent(kv, msg.tabId, deps.now(), msg.meetingId);
      } catch {
        // Fail closed: an unreadable consent record is never treated as consent.
        return fail(CONSENT_CHECK_FAILED_MESSAGE);
      }
      if (!consent.ok) return fail(consent.reason);
      const startedAt = deps.now();
      const next: RecorderState = {
        status: 'starting',
        tabId: msg.tabId,
        streamId: msg.streamId,
        meetingId: msg.meetingId,
        sessionId: '',
        startedAt,
        chunks: 0,
        lastHeartbeatAt: startedAt,
        ...(quotaWarning ? { storageWarning: quotaWarning } : {}),
      };
      let offscreenStarted = false;
      try {
        await kv.set(USED_STREAMS_KEY, [...used, msg.streamId].slice(-50));
        await saveState(kv, next);
        await deps.setBadge('').catch(() => undefined);
        await deps.ensureOffscreen();
        await deps.startWatchdog();
        offscreenStarted = true;
        await sendOffscreen(deps, {
          target: 'offscreen',
          type: 'OFFSCREEN_START',
          streamId: msg.streamId,
          startedAt,
          meetingId: msg.meetingId,
          consent: toAttestation(consent.record),
        });
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        // The offscreen doc may have created a session (e.g. it answered after our timeout): discard it so no
        // recording survives a failed Start. Closing the document (toIdle) also stops its capture tracks.
        if (offscreenStarted) {
          await sendOffscreen(deps, { target: 'offscreen', type: 'OFFSCREEN_DISCARD' }).catch(
            () => undefined,
          );
        }
        await toIdle(deps, next, e).catch(async () => {
          await deps.stopWatchdog().catch(() => undefined);
          await deps.closeOffscreen().catch(() => undefined);
        });
        return fail(e);
      }
      return status(next);
    }

    case 'STOP_RECORDING': {
      if (state.status === 'idle') return status(state);
      if (state.status === 'error') {
        await deps.setBadge('').catch(() => undefined);
        return status(await toIdle(deps, state));
      }
      const next: RecorderState = { ...state, status: 'stopping' };
      await saveState(kv, next);
      try {
        await sendOffscreen(deps, { target: 'offscreen', type: 'OFFSCREEN_STOP' });
      } catch {
        // Offscreen doc gone: finalize what was queued and reset.
        if (state.sessionId) {
          await deps
            .finalizeAfterCrash(state.sessionId, state.chunks, deps.now() - state.startedAt)
            .catch(() => undefined);
        }
        return status(await toIdle(deps, state, 'Recorder was not running'));
      }
      return status(next);
    }

    case 'REC_STARTED': {
      if (state.status !== 'starting') {
        // A late start (after Start failed or was stopped): nothing may keep recording or be uploaded.
        if (state.status === 'recording' && state.sessionId === msg.sessionId) return status(state);
        await addPendingDiscard(deps.durableKV, msg.sessionId);
        const ok = await sendOffscreen(deps, {
          target: 'offscreen',
          type: 'OFFSCREEN_DISCARD',
        }).then(
          () => true,
          () => false,
        );
        if (ok) await clearPendingDiscard(deps.durableKV, msg.sessionId);
        else await retryPendingDiscards(deps.durableKV, deps.discardLocal, deps.deleteLocal);
        if (state.status === 'idle') await deps.closeOffscreen().catch(() => undefined);
        return status(state);
      }
      // Bind the stream to the consented tab: Chrome must report that exact tab as captured.
      const captured = await deps.capturedTabIds().catch(() => [] as number[]);
      if (!captured.includes(state.tabId)) {
        // Record the marker first: if the offscreen discard hangs or the worker dies, the
        // cleanup is retried (here on failure, and on every service-worker start).
        await addPendingDiscard(deps.durableKV, msg.sessionId);
        const discarded = await sendOffscreen(deps, {
          target: 'offscreen',
          type: 'OFFSCREEN_DISCARD',
        }).then(
          () => true,
          () => false,
        );
        const idle = await toIdle(
          deps,
          state,
          'Captured tab does not match the tab you consented to record; recording discarded.',
        );
        if (discarded) {
          await clearPendingDiscard(deps.durableKV, msg.sessionId);
        } else {
          // Offscreen is closed by toIdle now, so nothing else writes; clean up directly.
          await retryPendingDiscards(deps.durableKV, deps.discardLocal, deps.deleteLocal);
          if ((await listFailedDiscards(deps.durableKV)).length) {
            await deps.setBadge('!').catch(() => undefined);
          }
        }
        return status(idle);
      }
      const next: RecorderState = {
        ...state,
        status: 'recording',
        sessionId: msg.sessionId,
        lastHeartbeatAt: deps.now(),
      };
      await saveState(kv, next);
      await deps.setBadge('REC').catch(() => undefined);
      return status(next);
    }

    case 'REC_HEARTBEAT': {
      if (state.status === 'idle' || state.status === 'error') return status(state);
      const next: RecorderState = { ...state, lastHeartbeatAt: deps.now() };
      await saveState(kv, next);
      return status(next);
    }

    case 'REC_CHUNK': {
      if (state.status === 'idle' || state.status === 'error') return status(state);
      const next: RecorderState = {
        ...state,
        chunks: Math.max(state.chunks, msg.seq + 1),
        lastHeartbeatAt: deps.now(),
      };
      await saveState(kv, next);
      return status(next);
    }

    case 'REC_STORAGE': {
      const lost = msg.event.kind === 'refused' || msg.event.lostPending > 0;
      const next: RecorderState = {
        ...state,
        storageWarning: describeStorageEvent(msg.event),
        ...(lost ? { incomplete: true } : {}),
      };
      await saveState(kv, next);
      return status(next);
    }

    case 'REC_STOPPED':
      if (state.status === 'error') return status(state);
      return status(await toIdle(deps, state));

    case 'REC_ERROR':
      return status(await toIdle(deps, state, msg.error));
  }
}
