/**
 * WXT_FEATURE_DIRECT_UPLOAD drain (background only; it holds the ADR-005 tokens).
 *
 * With the flag on and the chunked HTTP client off, the offscreen recorder keeps its chunks locally (the stub client
 * is non-durable, so chunks are marked uploaded, not deleted). Once a session is finalized and closed cleanly, this
 * assembles its chunks in seq order into one Blob and sends it through DirectUploadClient with the consent captured
 * at init. The local session is deleted only after the upload completes; a failure leaves it for the next drain.
 * Incomplete, aborted or pre-v0.4.1 (no consent) sessions are never uploaded.
 */
import type { StoredChunk, StoredSession } from './chunk-store.js';
import type { DirectUploadInput, DirectUploadResult } from './upload-direct.js';

export interface DirectDrainStore {
  listSessions(): Promise<StoredSession[]>;
  listChunks(sessionId?: string): Promise<StoredChunk[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface DirectDrainResult {
  uploaded: string[];
  failed: string[];
}

/** True for a session that is finished, closed without loss, and carries a consent attestation. */
export function isDirectUploadable(s: StoredSession): boolean {
  return Boolean(s.finalized && s.completed && !s.abortedReason && !s.incomplete && s.meta.consent);
}

const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
};

export function directUploadInput(s: StoredSession, chunks: StoredChunk[]): DirectUploadInput {
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const base = s.meta.mimeType.split(';')[0]!.trim();
  const stamp = s.meta.startedAt.replace(/[:.]/g, '-');
  return {
    blob: new Blob(
      ordered.map((c) => c.data),
      { type: s.meta.mimeType },
    ),
    filename: `recording-${stamp}.${EXT[base] ?? 'bin'}`,
    mimeType: s.meta.mimeType,
    meetingId: s.meta.meetingId,
    consent: s.meta.consent,
  };
}

export async function drainDirectUploads(
  store: DirectDrainStore,
  client: { upload(input: DirectUploadInput): Promise<DirectUploadResult> },
  opts: { isMarked?: (sessionId: string) => Promise<boolean> } = {},
): Promise<DirectDrainResult> {
  const result: DirectDrainResult = { uploaded: [], failed: [] };
  for (const s of await store.listSessions()) {
    if (!isDirectUploadable(s)) continue;
    if (await opts.isMarked?.(s.sessionId)) continue;
    const chunks = await store.listChunks(s.sessionId);
    if (!chunks.length) continue;
    try {
      await client.upload(directUploadInput(s, chunks));
      await store.deleteSession(s.sessionId);
      result.uploaded.push(s.sessionId);
    } catch {
      result.failed.push(s.sessionId);
    }
  }
  return result;
}
