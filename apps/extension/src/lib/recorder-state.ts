import type { KV } from './storage.js';

interface Common {
  lastError?: string;
  storageWarning?: string;
  incomplete?: boolean;
}

export type RecorderState =
  | ({ status: 'idle' } & Common)
  | ({
      status: 'starting' | 'recording' | 'stopping' | 'error';
      tabId: number;
      /** Stream id issued for tabId; one-shot. */
      streamId: string;
      sessionId: string;
      startedAt: number;
      chunks: number;
      /** Last heartbeat from the offscreen document (ms epoch). */
      lastHeartbeatAt: number;
    } & Common);

const KEY = 'recorder';

export async function loadState(kv: KV): Promise<RecorderState> {
  return (await kv.get<RecorderState>(KEY)) ?? { status: 'idle' };
}

export async function saveState(kv: KV, s: RecorderState): Promise<void> {
  await kv.set(KEY, s);
}
