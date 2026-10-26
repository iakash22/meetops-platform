import type { ChunkStore, StoredSession } from './chunk-store.js';
import type { CompletedChunk } from '@meetops/contracts/types';
import { MAX_DURATION_MS } from './contract-limits.js';
import { uploadChunk, type UploadClient } from './upload.js';

export interface DrainResult {
  uploaded: number;
  completed: number;
  /** Sessions aborted because chunks were lost to the storage cap (or had no chunks). */
  aborted: number;
  failed: number;
  /** Sessions abandoned (not uploaded) because they are marked for discard. */
  skipped: number;
}

/** Discard-marker guard: runs `fn` only if the session is not marked, atomically with marking. */
export interface DiscardGuard {
  isMarked: (sessionId: string) => Promise<boolean>;
  gate: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;
}

class Abandoned extends Error {}

async function guarded<T>(g: DiscardGuard | undefined, id: string, fn: () => Promise<T>) {
  if (!g) return fn();
  return g.gate(id, async () => {
    if (await g.isMarked(id)) throw new Abandoned(id);
    return fn();
  });
}

/**
 * Message used when a session is aborted because chunks were evicted/refused. Contract
 * The wire reason is AbortReason 'local_storage_exhausted' (contracts v0.2 @ a9d9d89).
 */
export const INCOMPLETE_ABORT_NOTE = 'chunks lost to local storage limit';

function digestsFor(s: StoredSession, chunkCount: number): CompletedChunk[] | undefined {
  const bySeq = new Map((s.digests ?? []).map((d) => [d.seq, d]));
  const out: CompletedChunk[] = [];
  for (let seq = 0; seq < chunkCount; seq++) {
    const d = bySeq.get(seq);
    if (!d) return undefined; // optional field: omit rather than send a partial list
    out.push(d);
  }
  return out;
}

async function close(
  store: ChunkStore,
  client: UploadClient,
  s: StoredSession,
  abortedReason?: string,
) {
  if (client.durable) await store.deleteSession(s.sessionId);
  else {
    await store.putSession({
      ...(await store.getSession(s.sessionId))!,
      completed: true,
      ...(abortedReason ? { abortedReason } : {}),
    });
  }
}

/**
 * Upload every not-yet-uploaded chunk in the store, in seq order per session, via presigned
 * PUTs, then complete finalized sessions. Sessions that lost chunks to the storage cap are
 * aborted (reason 'local_storage_exhausted') instead: the server requires seq 0..chunkCount-1 with no gaps.
 * Sessions with no chunks are aborted ('user_stopped'). Safe to call repeatedly. Chunks are
 * deleted only when the client is durable; otherwise they are marked uploaded and kept.
 * A failing session is skipped and retried on the next drain.
 */
export async function drainQueue(
  store: ChunkStore,
  client: UploadClient,
  onlySession?: string,
  now: () => number = Date.now,
  guard?: DiscardGuard,
): Promise<DrainResult> {
  const result: DrainResult = { uploaded: 0, completed: 0, aborted: 0, failed: 0, skipped: 0 };
  const sessions = (await store.listSessions()).filter(
    (s) => !s.completed && (onlySession === undefined || s.sessionId === onlySession),
  );
  for (const s of sessions) {
    try {
      if (guard && (await guard.isMarked(s.sessionId))) throw new Abandoned(s.sessionId);
      if (s.incomplete) {
        // Uploading the rest is pointless: complete() would fail on the gap. Abort now.
        await client.abort(s.sessionId, { reason: 'local_storage_exhausted' });
        if (client.durable) await store.deleteSession(s.sessionId);
        else await close(store, client, s, INCOMPLETE_ABORT_NOTE);
        result.aborted++;
        continue;
      }
      const pending = (await store.listChunks(s.sessionId))
        .filter((c) => !c.uploaded)
        .sort((a, b) => a.seq - b.seq);
      for (const c of pending) {
        const blob = new Blob([c.data], { type: 'application/octet-stream' });
        // Re-check the discard marker before every PUT (drain runs outside the state lock).
        const digest = await guarded(guard, s.sessionId, () =>
          uploadChunk(client, s.sessionId, c.seq, blob, now, c.sha256),
        );
        await store.recordDigest(s.sessionId, digest);
        if (client.durable) await store.deleteChunk(s.sessionId, c.seq);
        else await store.markUploaded(s.sessionId, c.seq);
        result.uploaded++;
      }
      if (s.finalized) {
        const fresh = (await store.getSession(s.sessionId)) ?? s;
        if (fresh.incomplete) continue; // marked during this drain; aborted next time
        if (s.finalized.chunkCount < 1) {
          await client.abort(s.sessionId, { reason: 'user_stopped' });
          await close(store, client, fresh, 'no chunks recorded');
          result.aborted++;
          continue;
        }
        const chunks = digestsFor(fresh, s.finalized.chunkCount);
        const fin = s.finalized;
        await guarded(guard, s.sessionId, () =>
          client.complete(s.sessionId, {
            chunkCount: fin.chunkCount,
            ...(chunks ? { chunks } : {}),
            durationMs: Math.min(Math.max(0, Math.round(fin.durationMs)), MAX_DURATION_MS),
          }),
        );
        await close(store, client, fresh);
        result.completed++;
      }
    } catch (err) {
      // A marked session is abandoned; the drain continues with the others.
      if (err instanceof Abandoned) result.skipped++;
      else result.failed++;
    }
  }
  return result;
}
