import type { KV } from './storage.js';

/**
 * Sessions that must be thrown away (captured-tab mismatch) but whose local data may still exist.
 * Kept in a persistent KV (chrome.storage.local in production), not storage.session: IndexedDB
 * chunks survive a browser restart, so the marker must too, or a later drain could upload them.
 */
const KEY = 'pendingDiscards';

export async function listPendingDiscards(kv: KV): Promise<string[]> {
  return (await kv.get<string[]>(KEY)) ?? [];
}

export async function addPendingDiscard(kv: KV, sessionId: string): Promise<void> {
  const ids = await listPendingDiscards(kv);
  if (!ids.includes(sessionId)) await kv.set(KEY, [...ids, sessionId]);
}

export async function clearPendingDiscard(kv: KV, sessionId: string): Promise<void> {
  const ids = (await listPendingDiscards(kv)).filter((id) => id !== sessionId);
  if (ids.length) await kv.set(KEY, ids);
  else await kv.remove(KEY);
}

/**
 * Retry every pending discard: `discardLocal` deletes the session and its chunks from IndexedDB
 * and aborts the upload session (consent_revoked). A marker is cleared only after success, so a
 * failure is retried on the next service-worker start. Returns the ids still pending.
 */
export async function retryPendingDiscards(
  kv: KV,
  discardLocal: (sessionId: string) => Promise<void>,
): Promise<string[]> {
  for (const id of await listPendingDiscards(kv)) {
    try {
      await discardLocal(id);
      await clearPendingDiscard(kv, id);
    } catch (err) {
      console.warn('MeetOps AI: discarding session failed; will retry', id, err);
    }
  }
  return listPendingDiscards(kv);
}
