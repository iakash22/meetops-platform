import type { ChunkStore } from './chunk-store.js';
import { MAX_DURATION_MS } from './contracts.js';
import { uploadChunk, type UploadClient } from './upload.js';

export interface DrainResult {
  uploaded: number;
  completed: number;
  failed: number;
}

/**
 * Upload every not-yet-uploaded chunk in the store, in seq order per session, via presigned
 * PUTs, then complete finalized sessions (or abort them if they have no chunks). Safe to call
 * repeatedly (on each chunk, on stop, on browser/extension restart). Chunks are deleted only
 * when the client is durable; otherwise they are marked uploaded and kept until a real upload
 * API exists. A failing session is skipped and retried on the next drain.
 */
export async function drainQueue(
  store: ChunkStore,
  client: UploadClient,
  onlySession?: string,
  now: () => number = Date.now,
): Promise<DrainResult> {
  const result: DrainResult = { uploaded: 0, completed: 0, failed: 0 };
  const sessions = (await store.listSessions()).filter(
    (s) => !s.completed && (onlySession === undefined || s.sessionId === onlySession),
  );
  for (const s of sessions) {
    try {
      const pending = (await store.listChunks(s.sessionId))
        .filter((c) => !c.uploaded)
        .sort((a, b) => a.seq - b.seq);
      for (const c of pending) {
        const blob = new Blob([c.data], { type: 'application/octet-stream' });
        await uploadChunk(client, s.sessionId, c.seq, blob, now);
        if (client.durable) await store.deleteChunk(s.sessionId, c.seq);
        else await store.markUploaded(s.sessionId, c.seq);
        result.uploaded++;
      }
      if (s.finalized) {
        if (s.finalized.chunkCount < 1) {
          await client.abort(s.sessionId, { reason: 'user_stopped' });
        } else {
          await client.complete(s.sessionId, {
            chunkCount: s.finalized.chunkCount,
            durationMs: Math.min(Math.max(0, Math.round(s.finalized.durationMs)), MAX_DURATION_MS),
          });
        }
        if (client.durable) await store.deleteSession(s.sessionId);
        else await store.putSession({ ...s, completed: true });
        result.completed++;
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}
