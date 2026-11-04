import type { ChunkStore, StoredSession } from './chunk-store.js';
import type { CompletedChunk } from '@meetops/contracts/types';
import { LOCAL_RECORDING_CHUNK_BYTES, MAX_DURATION_MS } from './contract-limits.js';
import { uploadChunk, type UploadClient } from './upload.js';

export interface DrainResult {
  uploaded: number;
  completed: number;
  /** Sessions aborted because chunks were lost to the storage cap (or had no chunks). */
  aborted: number;
  failed: number;
  /** Sessions abandoned (not uploaded) because they are marked for discard. */
  skipped: number;
  /** Sessions the server refused (409/413): kept locally, not aborted, surfaced in the popup for a retry. */
  held: number;
}

export interface DrainOptions {
  /** Also retry sessions previously held after a 409/413 (user pressed Retry in the popup). */
  includeHeld?: boolean;
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

/**
 * The server refused this step: 413 PAYLOAD_TOO_LARGE, or 409 (a checksum mismatch or missing chunk on complete, or
 * a conflict on the chunk-URL request). Retrying automatically won't help, but the recording is still the user's:
 * the drain HOLDS it locally (no abort, no delete) and the popup offers a retry. 404 is not a refusal: an API without
 * media routes answers 404 and the session simply retries on the next drain. Duck-typed for other upload clients.
 */
export function isHoldUploadError(
  err: unknown,
): { status: number; op: string; closed?: true } | null {
  if (!(err instanceof Error) || err.name !== 'UploadApiError') return null;
  const e = err as Error & { status?: unknown; op?: unknown; reason?: unknown };
  if (e.status !== 413 && e.status !== 409) return null;
  return {
    status: e.status,
    op: typeof e.op === 'string' ? e.op : 'unknown',
    // Terminal: the server aborted (e.g. consent_revoked) or failed the session. Retrying can never succeed.
    ...(e.status === 409 && e.reason === SESSION_CLOSED_REASON ? { closed: true as const } : {}),
  };
}

/** Contracts ConflictReason sent when the recording session is aborted or failed on the server. */
export const SESSION_CLOSED_REASON = 'RECORDING_SESSION_CLOSED';

export interface HeldSummary {
  /** Held recordings in total. */
  count: number;
  /** Of those, closed by the server for good (discard only). */
  closed: number;
  /** The local storage cap was hit while recordings were held. */
  storageFull?: boolean;
  /** Pending bytes of held recordings, and the local storage cap they count against. */
  bytes?: number;
  capBytes?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Popup copy for held recordings (never contains server text). */
export function heldMessage(h: HeldSummary): string {
  const parts: string[] = [];
  const retryable = h.count - h.closed;
  if (h.closed > 0)
    parts.push(
      `${plural(h.closed, 'recording', 'recordings')} can no longer be submitted: the server closed the ` +
        `session (for example, recording consent was revoked). Discard to remove ${h.closed === 1 ? 'it' : 'them'} ` +
        'from this device.',
    );
  if (retryable > 0)
    parts.push(
      h.storageFull
        ? `Local storage is full: ${plural(retryable, 'held recording is', 'held recordings are')} using the ` +
            'space, so new audio could not be saved. Retry upload or discard to free space.'
        : `${plural(retryable, 'recording', 'recordings')} could not be submitted (the server rejected the ` +
            `upload). ${retryable === 1 ? 'It is' : 'They are'} kept on this device; press Retry upload to try ` +
            'again, or Discard.',
    );
  if (h.storageFull && retryable === 0)
    parts.push('Local storage is full: discard to free space for new recordings.');
  return parts.join(' ');
}

/** Warn before recording once held data uses this share of the local cap. */
export const HELD_WARN_RATIO = 0.8;
/**
 * Room a new recording needs at minimum: one full local chunk (LOCAL_RECORDING_CHUNK_BYTES, the same constant the recorder
 * splits at). Less than this left after held data blocks Start.
 */
export const MIN_FREE_FOR_RECORDING_BYTES = LOCAL_RECORDING_CHUNK_BYTES;

export type HeldStorage = 'ok' | 'near-full' | 'full';

/** How held data limits a new recording: 'full' blocks Start, 'near-full' warns. */
export function heldStorageLevel(h: Pick<HeldSummary, 'bytes' | 'capBytes'>): HeldStorage {
  const bytes = h.bytes ?? 0;
  const cap = h.capBytes ?? 0;
  if (!cap || !bytes) return 'ok';
  if (cap - bytes < Math.min(MIN_FREE_FOR_RECORDING_BYTES, cap * 0.05)) return 'full';
  return bytes >= cap * HELD_WARN_RATIO ? 'near-full' : 'ok';
}

export const HELD_NEAR_FULL_MESSAGE =
  'Held recordings are using most of the local storage. A new recording may run out of space: retry or discard ' +
  'them first.';
/** Local bytes Start must account for: every chunk not uploaded yet (held or queued), and the cap. */
export interface PendingStorage {
  pendingBytes: number;
  capBytes: number;
}

/**
 * True when the cap cannot take one more full local chunk on top of the pending (never-evicted) bytes.
 * Throws on a nonsensical answer so Start fails closed.
 */
export function pendingStorageFull(p: PendingStorage): boolean {
  const { pendingBytes, capBytes } = p;
  if (
    !Number.isFinite(pendingBytes) ||
    !Number.isFinite(capBytes) ||
    pendingBytes < 0 ||
    capBytes <= 0
  ) {
    throw new Error('pending storage is unknown');
  }
  return capBytes - pendingBytes < Math.min(MIN_FREE_FOR_RECORDING_BYTES, capBytes);
}

export const PENDING_FULL_START_MESSAGE =
  'Local storage is full of recordings that have not uploaded yet, so recording was not started. Reconnect so ' +
  'they can upload, or discard them, then try again.';
export const PENDING_CHECK_FAILED_MESSAGE =
  'Could not check local recording storage, so recording was not started. Try again.';

export async function pendingStorage(store: ChunkStore): Promise<PendingStorage> {
  return { pendingBytes: await store.pendingBytes(), capBytes: store.config.maxBytes };
}

export const HELD_FULL_START_MESSAGE =
  'Local storage is full of held recordings. Retry upload or discard them before starting a new recording.';

/** Confirmation shown before held recordings are deleted. */
export const discardConfirmMessage = (n: number) =>
  `Discard ${plural(n, 'held recording', 'held recordings')} from this device? This cannot be undone.`;

export async function summarizeHeld(store: ChunkStore): Promise<HeldSummary> {
  const held = await listHeldSessions(store);
  return {
    count: held.length,
    closed: held.filter((s) => s.held?.closed).length,
    bytes: held.length ? await store.heldBytes() : 0,
    capBytes: store.config.maxBytes,
  };
}

/**
 * Delete every held recording locally (after the user confirmed in the popup). Sessions the server has not closed
 * are aborted best effort ('user_stopped': the user chose to drop them); closed ones are already gone server-side.
 */
export async function discardHeldSessions(
  store: ChunkStore,
  client: UploadClient,
): Promise<number> {
  const held = await listHeldSessions(store);
  for (const s of held) {
    if (!s.held?.closed)
      await client.abort(s.sessionId, { reason: 'user_stopped' }).catch(() => undefined);
    await store.deleteSession(s.sessionId);
  }
  return held.length;
}

/** Sessions held after a server refusal (not completed). */
export async function listHeldSessions(store: ChunkStore): Promise<StoredSession[]> {
  return (await store.listSessions()).filter((s) => !s.completed && s.held);
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
 * A failing session is skipped and retried on the next drain. A server refusal (413, 409) is never aborted or deleted:
 * the session is held locally with its chunks and skipped until `includeHeld` (the popup's Retry) is set.
 */
export async function drainQueue(
  store: ChunkStore,
  client: UploadClient,
  onlySession?: string,
  now: () => number = Date.now,
  guard?: DiscardGuard,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const result: DrainResult = {
    uploaded: 0,
    completed: 0,
    aborted: 0,
    failed: 0,
    skipped: 0,
    held: 0,
  };
  const sessions = (await store.listSessions()).filter(
    (s) => !s.completed && (onlySession === undefined || s.sessionId === onlySession),
  );
  for (const s of sessions) {
    if (s.held && (!opts.includeHeld || s.held.closed)) {
      result.held++;
      continue;
    }
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
      else {
        const hold = isHoldUploadError(err);
        if (!hold) {
          result.failed++;
          continue;
        }
        // M-1 / L-2: keep the recording (chunks and session) and tell the user; never abort or delete here.
        const fresh = await store.getSession(s.sessionId).catch(() => undefined);
        await store
          .putSession({ ...(fresh ?? s), held: { ...hold, at: now() } })
          .catch(() => undefined);
        result.held++;
      }
    }
  }
  return result;
}
