import { consumeConsent, recordConsent } from './consent-registry.js';
import {
  isBackgroundMessage,
  type BackgroundResponse,
  type BackgroundToOffscreen,
} from './messages.js';
import { loadState, saveState, type RecorderState } from './recorder-state.js';
import type { KV } from './storage.js';

export interface BackgroundDeps {
  kv: KV;
  now: () => number;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  sendToOffscreen: (msg: BackgroundToOffscreen) => Promise<unknown>;
  /** Tab ids Chrome reports as being tab-captured (chrome.tabCapture.getCapturedTabs). */
  capturedTabIds: () => Promise<number[]>;
  /** Toolbar badge: 'REC' while recording, '' when idle. */
  setBadge: (text: string) => Promise<void>;
}

export interface SenderInfo {
  /** True when the message came from this extension's own pages. */
  fromSelf: boolean;
  /** True when sent from the offscreen document. */
  fromOffscreen: boolean;
  /** True when sent from the action popup page. */
  fromPopup: boolean;
}

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
    ? { ok: true, status: 'idle', ...(s.lastError ? { lastError: s.lastError } : {}) }
    : { ok: true, status: s.status, tabId: s.tabId, startedAt: s.startedAt, chunks: s.chunks };

const fail = (error: string): BackgroundResponse => ({ ok: false, error });

export async function handleBackgroundMessage(
  deps: BackgroundDeps,
  msg: unknown,
  sender: SenderInfo,
): Promise<BackgroundResponse> {
  if (!sender.fromSelf) return fail('Untrusted sender');
  if (!isBackgroundMessage(msg)) return fail('Unknown or malformed message');
  const { kv } = deps;
  const state = await loadState(kv);

  const isEvent = msg.type.startsWith('REC_');
  if (isEvent && !sender.fromOffscreen)
    return fail('Recorder events must come from the offscreen document');
  if (!isEvent && !sender.fromPopup) return fail('Commands must come from the popup');

  switch (msg.type) {
    case 'GET_STATUS':
      return status(state);

    case 'ACK_CONSENT':
      await recordConsent(kv, msg.tabId, deps.now());
      return status(state);

    case 'START_RECORDING': {
      if (state.status !== 'idle') return fail('Already recording');
      const used = (await kv.get<string[]>(USED_STREAMS_KEY)) ?? [];
      if (used.includes(msg.streamId)) return fail('Stream id already used');
      const consent = await consumeConsent(kv, msg.tabId, deps.now());
      if (!consent.ok) return fail(consent.reason);
      await kv.set(USED_STREAMS_KEY, [...used, msg.streamId].slice(-50));
      const startedAt = deps.now();
      const next: RecorderState = {
        status: 'starting',
        tabId: msg.tabId,
        streamId: msg.streamId,
        sessionId: '',
        startedAt,
        chunks: 0,
      };
      await saveState(kv, next);
      try {
        await deps.ensureOffscreen();
        await deps.sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_START',
          streamId: msg.streamId,
          startedAt,
        });
      } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        await saveState(kv, { status: 'idle', lastError: e });
        return fail(e);
      }
      return status(next);
    }

    case 'STOP_RECORDING': {
      if (state.status === 'idle') return status(state);
      const next: RecorderState = { ...state, status: 'stopping' };
      await saveState(kv, next);
      try {
        await deps.sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
      } catch {
        // Offscreen doc gone (e.g. crashed): nothing is recording; reset.
        await saveState(kv, { status: 'idle', lastError: 'Recorder was not running' });
        await deps.closeOffscreen().catch(() => undefined);
        return status(await loadState(kv));
      }
      return status(next);
    }

    case 'REC_STARTED': {
      if (state.status !== 'starting') return status(state);
      // Bind the stream to the consented tab: Chrome must report that exact tab as captured.
      const captured = await deps.capturedTabIds().catch(() => [] as number[]);
      if (!captured.includes(state.tabId)) {
        await deps
          .sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' })
          .catch(() => undefined);
        const err: RecorderState = {
          status: 'idle',
          lastError: 'Captured tab does not match the tab you consented to record; stopped.',
        };
        await saveState(kv, err);
        await deps.closeOffscreen().catch(() => undefined);
        await deps.setBadge('!').catch(() => undefined);
        return status(err);
      }
      const next: RecorderState = { ...state, status: 'recording', sessionId: msg.sessionId };
      await saveState(kv, next);
      await deps.setBadge('REC').catch(() => undefined);
      return status(next);
    }

    case 'REC_CHUNK': {
      if (state.status === 'idle') return status(state);
      const next: RecorderState = { ...state, chunks: Math.max(state.chunks, msg.seq + 1) };
      await saveState(kv, next);
      return status(next);
    }

    case 'REC_STOPPED':
    case 'REC_ERROR': {
      const next: RecorderState =
        msg.type === 'REC_ERROR' ? { status: 'idle', lastError: msg.error } : { status: 'idle' };
      await saveState(kv, next);
      await deps.closeOffscreen().catch(() => undefined);
      await deps.setBadge(msg.type === 'REC_ERROR' ? '!' : '').catch(() => undefined);
      return status(next);
    }
  }
}
