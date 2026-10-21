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
}

export interface SenderInfo {
  /** True when the message came from this extension's own pages. */
  fromSelf: boolean;
  /** True when sent from the offscreen document. */
  fromOffscreen: boolean;
}

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
  if (!isEvent && sender.fromOffscreen) return fail('Offscreen document cannot issue commands');

  switch (msg.type) {
    case 'GET_STATUS':
      return status(state);

    case 'ACK_CONSENT':
      await recordConsent(kv, msg.tabId, deps.now());
      return status(state);

    case 'START_RECORDING': {
      if (state.status !== 'idle') return fail('Already recording');
      const consent = await consumeConsent(kv, msg.tabId, deps.now());
      if (!consent.ok) return fail(consent.reason);
      const startedAt = deps.now();
      const next: RecorderState = {
        status: 'starting',
        tabId: msg.tabId,
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
      const next: RecorderState = { ...state, status: 'recording', sessionId: msg.sessionId };
      await saveState(kv, next);
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
      return status(next);
    }
  }
}
