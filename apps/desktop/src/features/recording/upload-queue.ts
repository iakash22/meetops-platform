import type {
  AbortReason,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  ConsentAttestationInput,
  InitRecordingSessionRequest,
} from '@meetops/contracts';

import { AuthError } from '@/features/auth/auth-client';

/** CONTRACTS DEPENDENCY: `RecordingSource` is only `'tab'`; desktop sends `'desktop'` after a contracts bump. */
export type DesktopInitRecordingSessionRequest = Omit<InitRecordingSessionRequest, 'source'> & {
  source: 'desktop';
};

export interface LocalChunk {
  seq: number;
  sizeBytes: number;
  sha256: string;
}

export type QueueItemState = 'pending' | 'uploading' | 'failed' | 'done';

export interface QueueItem {
  id: string;
  /** ADR-012 Decision 3.5: upload only with a token for the same user and org. */
  userId: string;
  organizationId: string;
  meetingId: string;
  meetingTitle: string;
  mimeType: InitRecordingSessionRequest['mimeType'];
  startedAt: string;
  durationMs: number;
  chunks: LocalChunk[];
  consent: ConsentAttestationInput;
  state: QueueItemState;
  sessionId: string | null;
  uploadedSeqs: number[];
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
  lastError: string | null;
}

/** Local chunk bytes. Persistent impl (encrypted files, per-device keychain key, ADR-012 3.5) is Rust-side. */
export interface ChunkStore {
  put: (recordingId: string, seq: number, bytes: Uint8Array) => Promise<void>;
  read: (recordingId: string, seq: number) => Promise<Uint8Array>;
  remove: (recordingId: string) => Promise<void>;
  exists: (recordingId: string) => Promise<boolean>;
}

export interface RecordingUploadApi {
  init: (
    organizationId: string,
    body: DesktopInitRecordingSessionRequest,
  ) => Promise<{ sessionId: string }>;
  chunkUrl: (sessionId: string, body: ChunkUploadUrlRequest) => Promise<ChunkUploadUrlResponse>;
  put: (upload: ChunkUploadUrlResponse['upload'], body: Uint8Array) => Promise<void>;
  complete: (sessionId: string, body: CompleteRecordingSessionRequest) => Promise<unknown>;
  abort: (sessionId: string, reason: AbortReason) => Promise<void>;
}

export interface QueueContext {
  isOnline: () => boolean;
  /** Current signed-in user and org; null when signed out. */
  identity: () => { userId: string; organizationId: string } | null;
}

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const PERMANENT = new Set(['VALIDATION_FAILED', 'BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND']);

function userMessage(e: unknown): string {
  if (e instanceof AuthError) {
    if (e.code === 'VALIDATION_FAILED')
      return 'The server rejected this recording (consent or format).';
    if (e.code === 'UNAUTHENTICATED') return 'Sign in again to resume uploads.';
    if (e.code === 'RATE_LIMITED') return 'Too many uploads right now. Retrying shortly.';
  }
  return "Upload didn't finish. Retrying automatically.";
}

export type NewRecording = Omit<
  QueueItem,
  'state' | 'sessionId' | 'uploadedSeqs' | 'attempts' | 'nextAttemptAt' | 'queuedAt' | 'lastError'
>;

export interface UploadQueue {
  enqueue: (recording: NewRecording) => void;
  process: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  items: () => readonly QueueItem[];
  subscribe: (listener: () => void) => () => void;
}

/**
 * Offline upload queue for desktop recordings (same algorithm as mobile M5): init with consent, per-chunk signed URL,
 * PUT with signed headers verbatim, complete with every chunk's size + sha256, then verified local deletion. Backoff,
 * offline pause, resume from the last confirmed chunk, 7-day retention, and items wait while a different user/org is
 * signed in. Metadata is in memory until the Rust store lands, so the queue survives network loss, not app restarts.
 */
export function createUploadQueue(
  api: RecordingUploadApi,
  chunks: ChunkStore,
  ctx: QueueContext,
  now: () => number = Date.now,
): UploadQueue {
  let items: QueueItem[] = [];
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: QueueItem[]) => {
    items = next;
    listeners.forEach((l) => l());
  };
  const patch = (id: string, p: Partial<QueueItem>) =>
    set(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const drop = (id: string) => set(items.filter((i) => i.id !== id));
  const get = (id: string) => items.find((i) => i.id === id);

  async function deleteVerified(id: string) {
    await chunks.remove(id);
    if (await chunks.exists(id)) throw new Error('Local copy still present after delete.');
    drop(id);
  }

  async function upload(item: QueueItem) {
    patch(item.id, { state: 'uploading', lastError: null });
    let sessionId = item.sessionId;
    if (!sessionId) {
      ({ sessionId } = await api.init(item.organizationId, {
        mimeType: item.mimeType,
        startedAt: item.startedAt,
        source: 'desktop',
        meetingId: item.meetingId,
        consent: item.consent,
      }));
      patch(item.id, { sessionId });
    }
    const done = new Set(item.uploadedSeqs);
    for (const c of item.chunks) {
      if (done.has(c.seq)) continue;
      if (!ctx.isOnline()) throw new Error('offline');
      const { upload: signed } = await api.chunkUrl(sessionId, c);
      await api.put(signed, await chunks.read(item.id, c.seq));
      done.add(c.seq);
      patch(item.id, { uploadedSeqs: [...done].sort((a, b) => a - b) });
    }
    await api.complete(sessionId, {
      chunkCount: item.chunks.length,
      chunks: item.chunks,
      durationMs: item.durationMs,
    });
    patch(item.id, { state: 'done' });
    await deleteVerified(item.id);
  }

  async function pass() {
    const t = now();
    for (const item of [...items]) {
      if (t - item.queuedAt < RETENTION_MS) continue;
      if (item.sessionId)
        await api.abort(item.sessionId, 'local_storage_exhausted').catch(() => undefined);
      await chunks.remove(item.id).catch(() => undefined);
      drop(item.id);
    }
    for (const snapshot of [...items]) {
      if (!ctx.isOnline()) return;
      const who = ctx.identity();
      if (!who || who.userId !== snapshot.userId || who.organizationId !== snapshot.organizationId)
        continue;
      if (snapshot.state === 'failed' || snapshot.nextAttemptAt > t) continue;
      try {
        if (snapshot.state === 'done') await deleteVerified(snapshot.id);
        else await upload(snapshot);
      } catch (e) {
        const current = get(snapshot.id);
        if (!current) continue;
        const attempts = current.attempts + 1;
        const permanent =
          (e instanceof AuthError && PERMANENT.has(e.code)) || attempts >= MAX_ATTEMPTS;
        patch(snapshot.id, {
          state: current.state === 'done' ? 'done' : permanent ? 'failed' : 'pending',
          attempts,
          nextAttemptAt: t + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1)),
          lastError: (e as Error).message === 'offline' ? null : userMessage(e),
        });
      }
    }
  }

  return {
    enqueue(r) {
      if (r.chunks.length === 0) throw new Error('A recording needs at least one chunk.');
      set([
        ...items,
        {
          ...r,
          state: 'pending',
          sessionId: null,
          uploadedSeqs: [],
          attempts: 0,
          nextAttemptAt: 0,
          queuedAt: now(),
          lastError: null,
        },
      ]);
    },
    process() {
      running ??= pass().finally(() => {
        running = null;
      });
      return running;
    },
    async retry(id) {
      patch(id, { state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
      await this.process();
    },
    async discard(id) {
      const item = get(id);
      if (!item) return;
      if (item.sessionId && item.state !== 'done')
        await api.abort(item.sessionId, 'user_stopped').catch(() => undefined);
      await chunks.remove(id).catch(() => undefined);
      drop(id);
    },
    items: () => items,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** In-memory chunk store (dev, tests, and until the encrypted Rust store ships). */
export function createMemoryChunkStore(): ChunkStore {
  const map = new Map<string, Map<number, Uint8Array>>();
  return {
    put: async (id, seq, bytes) => {
      if (!map.has(id)) map.set(id, new Map());
      map.get(id)?.set(seq, bytes);
    },
    read: async (id, seq) => {
      const b = map.get(id)?.get(seq);
      if (!b) throw new Error('Missing local chunk.');
      return b;
    },
    remove: async (id) => void map.delete(id),
    exists: async (id) => map.has(id),
  };
}

/** Lowercase hex sha256 using WebCrypto (no dependency). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
