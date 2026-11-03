import type {
  CompleteRecordingSessionRequest,
  CompletedChunk,
  InitRecordingSessionRequest,
} from '@meetops/contracts/types';
import { toIsoTimestamp } from './upload.js';

/**
 * Persistent IndexedDB queue of recorded chunks, shared by the offscreen document (writer)
 * and the background service worker (drain on restart). Chunks are stored as ArrayBuffers.
 */
/**
 * 'evict-uploaded': when over the cap, delete chunks the server already confirmed (uploaded) to make room;
 * pending (not yet uploaded) chunks are NEVER evicted, the new chunk is refused instead.
 * 'refuse': never delete anything to make room.
 * A pending chunk leaves the store only after the server confirms its upload, or when the user discards it.
 */
export type EvictionPolicy = 'evict-uploaded' | 'refuse';

export interface ChunkStoreConfig {
  /** Max total bytes of stored chunk data. */
  maxBytes: number;
  policy: EvictionPolicy;
}

export const DEFAULT_STORE_CONFIG: ChunkStoreConfig = {
  maxBytes: 500 * 1024 * 1024,
  policy: 'evict-uploaded',
};

export interface StoredChunk {
  sessionId: string;
  seq: number;
  data: ArrayBuffer;
  size: number;
  mimeType: string;
  createdAt: number;
  uploaded: boolean;
  /** Lowercase hex SHA-256 of data (absent on pre-v0.2 records; computed at upload). */
  sha256?: string;
}

export interface HeldInfo {
  /** HTTP status of the refusal (409 or 413). */
  status: number;
  /** Upload operation that was refused. */
  op: string;
  /** Epoch ms when it was held. */
  at: number;
  /** The server closed the session for good (409 RECORDING_SESSION_CLOSED, e.g. consent_revoked): discard only. */
  closed?: true;
}

export interface StoredSession {
  sessionId: string;
  /**
   * The init request as sent. Sessions stored before contracts v0.4.1 have no `meta.consent`, so this MUST NOT be
   * replayed to initSession(): it would fail validation. Nothing does today; the drain only uploads chunks, completes
   * or aborts already-initialised sessions by id.
   */
  meta: InitRecordingSessionRequest;
  /** Set when recording ended (normally or after a crash). */
  finalized?: CompleteRecordingSessionRequest;
  /** Closed: completed or aborted on the server. */
  completed: boolean;
  /** Some chunks were evicted or refused before upload: the session must be aborted, not completed. */
  incomplete?: { lostChunks: number };
  /** Set when the session was aborted instead of completed. */
  abortedReason?: string;
  /**
   * Held locally after the server refused it (409 on a chunk URL / complete, or 413). Never aborted or deleted for
   * that: the drain skips it until the user retries from the popup (see drain.ts releaseHeldSessions).
   */
  held?: HeldInfo;
  /** Digests of uploaded chunks, sent with complete(). */
  digests?: CompletedChunk[];
}

export type PutResult =
  | {
      stored: true;
      evictedCount: number;
      evictedBytes: number;
      /** Sessions that lost not-yet-uploaded chunks to eviction (now marked incomplete). */
      damagedSessions: string[];
      /** Evicted chunks that had not been uploaded yet (real data loss). */
      lostPending: number;
    }
  | { stored: false; reason: 'over-cap' };

/**
 * Records written before contracts v0.2 stored meta.startedAt as epoch ms. Normalize on read
 * so the upload client always receives ISO 8601; unparseable values fall back to the epoch.
 */
export function normalizeSession(raw: StoredSession): StoredSession {
  const startedAt = raw.meta.startedAt as string | number;
  if (typeof startedAt === 'string' && !/^\d+$/.test(startedAt)) {
    try {
      return { ...raw, meta: { ...raw.meta, startedAt: toIsoTimestamp(startedAt) } };
    } catch {
      return { ...raw, meta: { ...raw.meta, startedAt: new Date(0).toISOString() } };
    }
  }
  const ms = Number(startedAt);
  return {
    ...raw,
    meta: { ...raw.meta, startedAt: new Date(Number.isFinite(ms) ? ms : 0).toISOString() },
  };
}

const DB_NAME = 'meetops-ai-recorder';
const CHUNKS = 'chunks';
const SESSIONS = 'sessions';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class ChunkStore {
  private constructor(
    private readonly db: IDBDatabase,
    readonly config: ChunkStoreConfig,
  ) {}

  static async open(
    config: ChunkStoreConfig = DEFAULT_STORE_CONFIG,
    factory: IDBFactory = indexedDB,
    name: string = DB_NAME,
  ): Promise<ChunkStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'seq'] });
      db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
    };
    return new ChunkStore(await req(open), config);
  }

  close(): void {
    this.db.close();
  }

  async putSession(s: StoredSession): Promise<void> {
    const tx = this.db.transaction(SESSIONS, 'readwrite');
    tx.objectStore(SESSIONS).put(s);
    await done(tx);
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const tx = this.db.transaction(SESSIONS, 'readonly');
    const s = (await req(tx.objectStore(SESSIONS).get(sessionId))) as StoredSession | undefined;
    return s && normalizeSession(s);
  }

  async listSessions(): Promise<StoredSession[]> {
    const tx = this.db.transaction(SESSIONS, 'readonly');
    return ((await req(tx.objectStore(SESSIONS).getAll())) as StoredSession[]).map(
      normalizeSession,
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const tx = this.db.transaction([SESSIONS, CHUNKS], 'readwrite');
    tx.objectStore(SESSIONS).delete(sessionId);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]));
    await done(tx);
  }

  /** Mark a session as ended so a later drain will call complete(). */
  async finalizeSession(
    sessionId: string,
    summary: CompleteRecordingSessionRequest,
  ): Promise<void> {
    const s = await this.getSession(sessionId);
    if (s && !s.finalized) await this.putSession({ ...s, finalized: summary });
  }

  async listChunks(sessionId?: string): Promise<StoredChunk[]> {
    const tx = this.db.transaction(CHUNKS, 'readonly');
    const range =
      sessionId === undefined
        ? undefined
        : IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
    const all = (await req(tx.objectStore(CHUNKS).getAll(range))) as StoredChunk[];
    return all.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  }

  /** Bytes of not-yet-uploaded chunks belonging to held (server-refused, not completed) sessions. */
  async heldBytes(): Promise<number> {
    const held = new Set(
      (await this.listSessions()).filter((s) => s.held && !s.completed).map((s) => s.sessionId),
    );
    if (!held.size) return 0;
    return (await this.listChunks())
      .filter((c) => !c.uploaded && held.has(c.sessionId))
      .reduce((n, c) => n + c.size, 0);
  }

  async totalBytes(): Promise<number> {
    return (await this.listChunks()).reduce((n, c) => n + c.size, 0);
  }

  /**
   * Store a chunk, enforcing the size cap. With 'evict-uploaded' the oldest already-uploaded chunks are deleted
   * until the new one fits (pending chunks never are); otherwise, or with 'refuse', the new chunk is rejected.
   * Single transaction, so concurrent writers cannot overshoot the cap.
   */
  async putChunk(
    c: Omit<StoredChunk, 'size' | 'uploaded'> & { uploaded?: boolean },
  ): Promise<PutResult> {
    const size = c.data.byteLength;
    if (size > this.config.maxBytes) return { stored: false, reason: 'over-cap' };
    const tx = this.db.transaction([CHUNKS, SESSIONS], 'readwrite');
    const store = tx.objectStore(CHUNKS);
    // Evict already-uploaded chunks first (no data loss), then the oldest pending ones.
    const existing = ((await req(store.getAll())) as StoredChunk[]).sort(
      (a, b) =>
        Number(b.uploaded) - Number(a.uploaded) || a.createdAt - b.createdAt || a.seq - b.seq,
    );
    let total = existing.reduce((n, x) => n + x.size, 0);
    // Only chunks the server already confirmed may be deleted to make room: a pending chunk is the only copy of
    // that audio (held or not, this recording or another), so it is never evicted. If confirmed chunks cannot
    // free enough space the new chunk is refused and the recorder surfaces a storage warning.
    const evictable = existing.filter((x) => x.uploaded);
    const evictableBytes = evictable.reduce((n, x) => n + x.size, 0);
    let evictedCount = 0;
    let evictedBytes = 0;
    const lost = new Map<string, number>();
    if (total + size > this.config.maxBytes) {
      if (this.config.policy === 'refuse') {
        tx.abort();
        await done(tx).catch(() => undefined);
        return { stored: false, reason: 'over-cap' };
      }
      if (total - evictableBytes + size > this.config.maxBytes) {
        tx.abort();
        await done(tx).catch(() => undefined);
        return { stored: false, reason: 'over-cap' };
      }
      const gone = new Set<string>();
      const evict = (old: StoredChunk) => {
        const key = `${old.sessionId}\u0000${old.seq}`;
        if (gone.has(key)) return;
        gone.add(key);
        store.delete([old.sessionId, old.seq]);
        total -= old.size;
        evictedCount++;
        evictedBytes += old.size;
        if (!old.uploaded) lost.set(old.sessionId, (lost.get(old.sessionId) ?? 0) + 1);
      };
      for (const old of evictable) {
        if (total + size <= this.config.maxBytes) break;
        if (gone.has(`${old.sessionId}\u0000${old.seq}`)) continue;
        evict(old);
      }
    }
    const sessions = tx.objectStore(SESSIONS);
    for (const [sid, n] of lost) {
      const s = (await req(sessions.get(sid))) as StoredSession | undefined;
      if (s) {
        sessions.put({ ...s, incomplete: { lostChunks: (s.incomplete?.lostChunks ?? 0) + n } });
      }
    }
    store.put({ ...c, size, uploaded: c.uploaded ?? false } satisfies StoredChunk);
    await done(tx);
    const lostPending = [...lost.values()].reduce((a, b) => a + b, 0);
    return {
      stored: true,
      evictedCount,
      evictedBytes,
      damagedSessions: [...lost.keys()],
      lostPending,
    };
  }

  /** Record that a chunk of this session was refused or otherwise lost before upload. */
  async markIncomplete(sessionId: string, lostChunks = 1): Promise<void> {
    const s = await this.getSession(sessionId);
    if (s) {
      await this.putSession({
        ...s,
        incomplete: { lostChunks: (s.incomplete?.lostChunks ?? 0) + lostChunks },
      });
    }
  }

  async recordDigest(sessionId: string, digest: CompletedChunk): Promise<void> {
    const s = await this.getSession(sessionId);
    if (!s) return;
    const digests = (s.digests ?? []).filter((d) => d.seq !== digest.seq);
    digests.push(digest);
    await this.putSession({ ...s, digests });
  }

  async markUploaded(sessionId: string, seq: number): Promise<void> {
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    const store = tx.objectStore(CHUNKS);
    const c = (await req(store.get([sessionId, seq]))) as StoredChunk | undefined;
    if (c) store.put({ ...c, uploaded: true });
    await done(tx);
  }

  async deleteChunk(sessionId: string, seq: number): Promise<void> {
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).delete([sessionId, seq]);
    await done(tx);
  }
}
