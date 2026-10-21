import type { UploadSessionMeta, UploadSummary } from './upload.js';

/**
 * Persistent IndexedDB queue of recorded chunks, shared by the offscreen document (writer)
 * and the background service worker (drain on restart). Chunks are stored as ArrayBuffers.
 */
export type EvictionPolicy = 'evict-oldest' | 'refuse';

export interface ChunkStoreConfig {
  /** Max total bytes of stored chunk data. */
  maxBytes: number;
  policy: EvictionPolicy;
}

export const DEFAULT_STORE_CONFIG: ChunkStoreConfig = {
  maxBytes: 500 * 1024 * 1024,
  policy: 'evict-oldest',
};

export interface StoredChunk {
  sessionId: string;
  seq: number;
  data: ArrayBuffer;
  size: number;
  mimeType: string;
  createdAt: number;
  uploaded: boolean;
}

export interface StoredSession {
  sessionId: string;
  meta: UploadSessionMeta;
  /** Set when recording ended (normally or after a crash). */
  finalized?: UploadSummary;
  completed: boolean;
}

export type PutResult =
  | { stored: true; evictedCount: number; evictedBytes: number }
  | { stored: false; reason: 'over-cap' };

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
    return (await req(tx.objectStore(SESSIONS).get(sessionId))) as StoredSession | undefined;
  }

  async listSessions(): Promise<StoredSession[]> {
    const tx = this.db.transaction(SESSIONS, 'readonly');
    return (await req(tx.objectStore(SESSIONS).getAll())) as StoredSession[];
  }

  async deleteSession(sessionId: string): Promise<void> {
    const tx = this.db.transaction([SESSIONS, CHUNKS], 'readwrite');
    tx.objectStore(SESSIONS).delete(sessionId);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]));
    await done(tx);
  }

  /** Mark a session as ended so a later drain will call complete(). */
  async finalizeSession(sessionId: string, summary: UploadSummary): Promise<void> {
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

  async totalBytes(): Promise<number> {
    return (await this.listChunks()).reduce((n, c) => n + c.size, 0);
  }

  /**
   * Store a chunk, enforcing the size cap. With 'evict-oldest' the oldest chunks (across all
   * sessions) are deleted until the new one fits; with 'refuse' the new chunk is rejected.
   * Single transaction, so concurrent writers cannot overshoot the cap.
   */
  async putChunk(
    c: Omit<StoredChunk, 'size' | 'uploaded'> & { uploaded?: boolean },
  ): Promise<PutResult> {
    const size = c.data.byteLength;
    if (size > this.config.maxBytes) return { stored: false, reason: 'over-cap' };
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    const store = tx.objectStore(CHUNKS);
    const existing = ((await req(store.getAll())) as StoredChunk[]).sort(
      (a, b) => a.createdAt - b.createdAt || a.seq - b.seq,
    );
    let total = existing.reduce((n, x) => n + x.size, 0);
    let evictedCount = 0;
    let evictedBytes = 0;
    if (total + size > this.config.maxBytes) {
      if (this.config.policy === 'refuse') {
        tx.abort();
        await done(tx).catch(() => undefined);
        return { stored: false, reason: 'over-cap' };
      }
      for (const old of existing) {
        if (total + size <= this.config.maxBytes) break;
        store.delete([old.sessionId, old.seq]);
        total -= old.size;
        evictedCount++;
        evictedBytes += old.size;
      }
    }
    store.put({ ...c, size, uploaded: c.uploaded ?? false } satisfies StoredChunk);
    await done(tx);
    return { stored: true, evictedCount, evictedBytes };
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
