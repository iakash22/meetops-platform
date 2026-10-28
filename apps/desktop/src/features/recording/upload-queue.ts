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
  /** Set when the local copy must be deleted (discard, retention, or after upload) but the delete hasn't been
   * verified yet. The record is kept, and the delete retried every pass, so no encrypted orphans are left behind. */
  pendingDelete?: boolean;
  /** Failed local-delete attempts this launch (bounded with backoff; a durable tombstone retries next launch). */
  deleteAttempts?: number;
  /** True once the device-wide discard tombstone is durable; until then the item is held and the write retried. */
  tombstoned?: boolean;
}

export type LedgerMark = 'discarded' | 'uploaded';

/**
 * Small durable record of recording ids that must never upload again (discarded) or again (server upload complete).
 * Independent of the chunk store and of which account is signed in, so it holds even when a store write fails.
 * Ids only (random UUIDs); no recording data.
 */
export interface RecordingLedger {
  /** Throws when it can't be saved. */
  mark: (id: string, kind: LedgerMark) => void;
  get: (id: string) => LedgerMark | null;
  clear: (id: string) => void;
}

export function createMemoryLedger(): RecordingLedger {
  const m = new Map<string, LedgerMark>();
  return {
    mark: (id, k) => void m.set(id, k),
    get: (id) => m.get(id) ?? null,
    clear: (id) => void m.delete(id),
  };
}

const LEDGER_STORAGE_NAME = 'meetops.recording-ledger.v1';

/** localStorage-backed ledger for the desktop webview. */
export function createLocalLedger(storage: Storage, slot = LEDGER_STORAGE_NAME): RecordingLedger {
  const read = (): Record<string, LedgerMark> => {
    try {
      return JSON.parse(storage.getItem(slot) ?? '{}') as Record<string, LedgerMark>;
    } catch {
      return {};
    }
  };
  return {
    mark: (id, k) => storage.setItem(slot, JSON.stringify({ ...read(), [id]: k })),
    get: (id) => read()[id] ?? null,
    clear: (id) => {
      const all = read();
      delete all[id];
      storage.setItem(slot, JSON.stringify(all));
    },
  };
}

export interface StoredRecording {
  id: string;
  /** Tombstoned (discarded or expired): only ever deleted, never re-queued or uploaded. */
  discarded: boolean;
}

/** Local chunk bytes. Persistent impl (encrypted files, per-device keychain key, ADR-012 3.5) is Rust-side. */
export interface ChunkStore {
  put: (recordingId: string, seq: number, bytes: Uint8Array) => Promise<void>;
  read: (recordingId: string, seq: number) => Promise<Uint8Array>;
  remove: (recordingId: string) => Promise<void>;
  /** True while anything of the recording is still stored, including data from earlier launches. */
  exists: (recordingId: string) => Promise<boolean>;
  /** Recordings stored for the signed-in account, excluding ones still being written this launch. */
  list: () => Promise<StoredRecording[]>;
  /** Durable, device-wide discard marker, written before any delete is attempted (consent: M-1). */
  tombstone: (recordingId: string) => Promise<void>;
  /** Queue metadata, stored (encrypted) beside the chunks so the queue survives restarts. */
  saveMeta: (recordingId: string, meta: string) => Promise<void>;
  /** Null when the recording has no metadata (e.g. the app quit mid-recording). */
  readMeta: (recordingId: string) => Promise<string | null>;
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
  /** Durable discard/upload marks (default: in memory). */
  ledger?: RecordingLedger;
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
 * signed in. Metadata is persisted beside the chunks, and each account's leftovers are re-queued on its first pass after a restart.
 */
export function createUploadQueue(
  api: RecordingUploadApi,
  chunks: ChunkStore,
  ctx: QueueContext,
  now: () => number = Date.now,
): UploadQueue {
  const ledger = ctx.ledger ?? createMemoryLedger();
  let items: QueueItem[] = [];
  let running: Promise<void> | null = null;
  const hydrated = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: QueueItem[]) => {
    items = next;
    listeners.forEach((l) => l());
  };
  const get = (id: string) => items.find((i) => i.id === id);
  // Metadata writes are serialized per recording, so the newest state always lands last. `finalize` stops new
  // writes, lets queued ones finish, then writes and awaits the final state ('done' or discarded) before any delete,
  // so a late write can't recreate the folder and an older state can't win (N-3, M-2).
  const saving = new Map<string, Promise<void>>();
  const closed = new Set<string>();
  const persist = (item: QueueItem | undefined) => {
    if (!item || item.pendingDelete || closed.has(item.id)) return;
    const json = JSON.stringify(item);
    const next = (saving.get(item.id) ?? Promise.resolve()).then(() =>
      chunks.saveMeta(item.id, json).catch(() => undefined),
    );
    saving.set(item.id, next);
  };
  async function finalize(id: string, final?: QueueItem) {
    if (closed.has(id)) return;
    closed.add(id);
    await saving.get(id);
    saving.delete(id);
    if (final) await chunks.saveMeta(id, JSON.stringify(final)).catch(() => undefined);
  }
  const patch = (id: string, p: Partial<QueueItem>) => {
    set(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
    persist(get(id));
  };
  const drop = (id: string) => set(items.filter((i) => i.id !== id));

  async function deleteVerified(id: string) {
    await finalize(id);
    await chunks.remove(id);
    if (await chunks.exists(id)) throw new Error('Local copy still present after delete.');
    drop(id);
    try {
      ledger.clear(id);
    } catch {
      // A stale mark only forces delete-only handling for an id that no longer exists.
    }
  }

  const NOT_DURABLE = "Couldn't save the discard yet. It won't upload; retrying.";

  async function writeTombstone(id: string): Promise<boolean> {
    try {
      await chunks.tombstone(id);
      set(items.map((i) => (i.id === id ? { ...i, tombstoned: true } : i)));
      return true;
    } catch {
      set(items.map((i) => (i.id === id ? { ...i, lastError: NOT_DURABLE } : i)));
      return false;
    }
  }

  /**
   * Blocks the recording in memory at once, then records the discard durably before any delete (M-1, M-1b): the
   * ledger mark, a discarded metadata state (own account), and the device-wide tombstone. A failed tombstone is
   * reported (returns false), the item stays blocked, and the tombstone is retried every pass.
   */
  async function markDiscarded(id: string): Promise<boolean> {
    const item = get(id);
    if (!item) return true;
    set(items.map((i) => (i.id === id ? { ...i, pendingDelete: true } : i)));
    try {
      ledger.mark(id, 'discarded');
    } catch {
      // Still covered by the tombstone/metadata below; a full failure is reported.
    }
    if (owns(item)) await finalize(id, { ...item, pendingDelete: true });
    return writeTombstone(id);
  }

  /** Delete now, or keep the record flagged and retry with backoff, up to MAX_ATTEMPTS per launch (L-3, N-2). */
  async function deleteOrFlag(id: string) {
    try {
      await deleteVerified(id);
    } catch {
      const t = now();
      set(
        items.map((i) => {
          if (i.id !== id) return i;
          const deleteAttempts = (i.deleteAttempts ?? 0) + 1;
          return {
            ...i,
            pendingDelete: true,
            deleteAttempts,
            nextAttemptAt:
              t + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (deleteAttempts - 1)),
            lastError:
              i.lastError === NOT_DURABLE
                ? NOT_DURABLE
                : deleteAttempts >= MAX_ATTEMPTS
                  ? "Couldn't remove the local copy. It will be retried next launch."
                  : "Couldn't remove the local copy. Retrying.",
          };
        }),
      );
    }
  }

  /** Once per account: re-queue recordings left on disk by earlier launches; delete ones that can't be resumed. */
  async function hydrate(key: string) {
    if (hydrated.has(key)) return;
    const known = new Set(items.map((i) => i.id));
    for (const { id, discarded } of await chunks.list()) {
      if (known.has(id)) continue;
      if (discarded || ledger.get(id) === 'discarded') {
        // Discarded or expired earlier (maybe by another account): delete only. A failure leaves the tombstone,
        // so the next launch tries again; it is never re-queued.
        await chunks.remove(id).catch(() => undefined);
        continue;
      }
      let item: QueueItem | null = null;
      try {
        const raw = await chunks.readMeta(id);
        item = raw ? (JSON.parse(raw) as QueueItem) : null;
      } catch {
        item = null;
      }
      if (item?.pendingDelete || item?.state === 'done' || ledger.get(id)) {
        // Discarded, or its server upload already completed: delete only, never upload again (M-1b, M-2).
        await chunks.remove(id).catch(() => undefined);
        continue;
      }
      if (!item || item.id !== id || !Array.isArray(item.chunks)) {
        // No usable metadata (quit mid-recording or corrupt): it can never be uploaded, so don't keep it.
        await chunks.remove(id).catch(() => undefined);
        continue;
      }
      set([...items, { ...item, state: item.state === 'uploading' ? 'pending' : item.state }]);
    }
    hydrated.add(key);
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
      const current = get(item.id);
      if (!current || current.pendingDelete) throw new Error('discarded');
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
    // Server upload is complete: record that durably (ledger + awaited 'done' metadata) before stopping saves and
    // deleting, so a restart after a failed delete never uploads it again (M-2).
    try {
      ledger.mark(item.id, 'uploaded');
    } catch {
      // The awaited 'done' metadata below still covers it.
    }
    patch(item.id, { state: 'done' });
    const final = get(item.id);
    await finalize(item.id, final ? { ...final, state: 'done' } : undefined);
    await deleteVerified(item.id);
  }

  const owns = (i: QueueItem) => {
    const who = ctx.identity();
    return !!who && who.userId === i.userId && who.organizationId === i.organizationId;
  };

  async function pass() {
    const who = ctx.identity();
    if (who) await hydrate(`${who.userId}:${who.organizationId}`).catch(() => undefined);
    const t = now();
    // Local deletes and retention need only the owning account (the store is namespaced per account), not network.
    for (const item of [...items]) {
      if (item.pendingDelete && !item.tombstoned) await writeTombstone(item.id);
      if (!owns(item)) continue;
      if (item.pendingDelete) {
        if (item.nextAttemptAt <= t && (item.deleteAttempts ?? 0) < MAX_ATTEMPTS)
          await deleteOrFlag(item.id);
        continue;
      }
      if (t - item.queuedAt < RETENTION_MS) continue;
      await markDiscarded(item.id);
      if (item.sessionId)
        await api.abort(item.sessionId, 'local_storage_exhausted').catch(() => undefined);
      await deleteOrFlag(item.id);
    }
    for (const snapshot of [...items]) {
      if (!ctx.isOnline()) return;
      if (!owns(snapshot) || snapshot.pendingDelete) continue;
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
      const item: QueueItem = {
        ...r,
        state: 'pending',
        sessionId: null,
        uploadedSeqs: [],
        attempts: 0,
        nextAttemptAt: 0,
        queuedAt: now(),
        lastError: null,
      };
      set([...items, item]);
      persist(item);
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
      // Durable first: the tombstone is device-wide, so it holds even for another account's recording.
      const durable = await markDiscarded(id);
      if (item.sessionId && item.state !== 'done')
        await api.abort(item.sessionId, 'user_stopped').catch(() => undefined);
      // Another account's store namespace isn't addressable now; its tombstone makes it delete-only at its next sign-in.
      if (owns(item)) await deleteOrFlag(id);
      if (!durable && get(id)) throw new Error(NOT_DURABLE);
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
  const meta = new Map<string, string>();
  const tombs = new Set<string>();
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
    remove: async (id) => {
      map.delete(id);
      meta.delete(id);
      tombs.delete(id);
    },
    exists: async (id) => map.has(id) || meta.has(id),
    list: async () =>
      [...new Set([...map.keys(), ...meta.keys()])]
        .filter((id) => meta.has(id))
        .map((id) => ({ id, discarded: tombs.has(id) })),
    tombstone: async (id) => void tombs.add(id),

    saveMeta: async (id, m) => {
      if (!tombs.has(id)) meta.set(id, m);
    },
    readMeta: async (id) => meta.get(id) ?? null,
  };
}

/** Lowercase hex sha256 using WebCrypto (no dependency). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
