import { ApiError } from '../api/client';
import type { UploadQueue, UploadQueueStatus } from '../data/uploadQueue';
import type {
  ChunkSource,
  NetworkStatus,
  QueueItem,
  QueueStore,
  RecordingUploadApi,
} from './types';

/** R4 retention: local audio is kept at most 7 days, with a warning from day 6. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_WARNING_MS = 6 * 24 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export interface UploadQueueEngineOptions {
  store: QueueStore;
  chunks: ChunkSource;
  api: RecordingUploadApi;
  network: NetworkStatus;
  now?: () => number;
}

export type NewRecording = Omit<
  QueueItem,
  'state' | 'sessionId' | 'uploadedSeqs' | 'attempts' | 'nextAttemptAt' | 'queuedAt' | 'lastError'
>;

export interface UploadQueueEngine extends UploadQueue {
  enqueue(recording: NewRecording): Promise<void>;
  /** Runs one pass over due items. Safe to call often; concurrent calls share one pass. */
  process(): Promise<void>;
  /** Retries a failed item now. */
  retry(id: string): Promise<void>;
  items(): Promise<QueueItem[]>;
  /** R4 logout / org-switch wipe: aborts open sessions and deletes every local recording. */
  wipe(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Non-retryable: the server rejected the recording itself (consent, validation, gone). */
const isPermanent = (e: unknown) =>
  e instanceof ApiError &&
  (e.code === 'VALIDATION_FAILED' ||
    e.code === 'BAD_REQUEST' ||
    e.code === 'FORBIDDEN' ||
    e.code === 'NOT_FOUND');

const userMessage = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.reason === 'CONSENT_REQUIRED' || e.reason === 'CONSENT_INVALID')
      return 'The consent record was rejected. Record again to upload.';
    if (e.code === 'UNAUTHENTICATED') return 'Sign in again to resume uploads.';
    if (e.code === 'RATE_LIMITED') return 'Too many uploads right now. Retrying shortly.';
  }
  return "Upload didn't finish. Retrying automatically.";
};

export function createUploadQueueEngine({
  store,
  chunks,
  api,
  network,
  now = Date.now,
}: UploadQueueEngineOptions): UploadQueueEngine {
  let cache: QueueItem[] | null = null;
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const load = async () => (cache ??= await store.load());
  const persist = async (items: QueueItem[]) => {
    cache = items;
    await store.save(items);
    listeners.forEach((l) => l());
  };
  const update = async (id: string, patch: Partial<QueueItem>) => {
    const items = await load();
    await persist(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  async function deleteVerified(id: string) {
    await chunks.remove(id);
    // R6: verified deletion. A leftover file is retried on the next pass instead of being forgotten.
    if (await chunks.exists(id)) throw new Error('Local copy still present after delete.');
  }

  async function uploadOne(item: QueueItem) {
    await update(item.id, { state: 'uploading', lastError: null });
    let sessionId = item.sessionId;
    if (!sessionId) {
      ({ sessionId } = await api.init(item.organizationId, {
        mimeType: item.mimeType,
        startedAt: item.startedAt,
        source: 'mobile',
        meetingId: item.meetingId,
        consent: item.consent,
      }));
      await update(item.id, { sessionId });
    }
    const done = new Set(item.uploadedSeqs);
    for (const chunk of item.chunks) {
      if (done.has(chunk.seq)) continue;
      if (!network.isOnline()) throw new Error('offline');
      const { upload } = await api.chunkUrl(sessionId, chunk);
      await api.put(upload, await chunks.read(item.id, chunk.seq));
      done.add(chunk.seq);
      await update(item.id, { uploadedSeqs: [...done].sort((a, b) => a - b) });
    }
    // Server checks every chunk's size and sha256 against what was signed (checksum confirmation).
    await api.complete(sessionId, {
      chunkCount: item.chunks.length,
      chunks: item.chunks,
      durationMs: item.durationMs,
    });
    await update(item.id, { state: 'done' });
    await deleteVerified(item.id);
    const items = await load();
    await persist(items.filter((i) => i.id !== item.id));
  }

  async function pass() {
    const t = now();
    // R4 retention cap.
    for (const item of await load()) {
      if (t - item.queuedAt >= RETENTION_MS) {
        if (item.sessionId)
          await api.abort(item.sessionId, 'local_storage_exhausted').catch(() => undefined);
        await chunks.remove(item.id).catch(() => undefined);
        await persist((await load()).filter((i) => i.id !== item.id));
      }
    }
    for (const item of await load()) {
      if (!network.isOnline()) return;
      if (item.state === 'failed' || item.nextAttemptAt > t) continue;
      try {
        if (item.state === 'done') {
          await deleteVerified(item.id);
          await persist((await load()).filter((i) => i.id !== item.id));
          continue;
        }
        await uploadOne(item);
      } catch (e) {
        const attempts = item.attempts + 1;
        const current = (await load()).find((i) => i.id === item.id);
        if (!current) continue;
        const permanent = isPermanent(e) || attempts >= MAX_ATTEMPTS;
        await update(item.id, {
          // A completed upload whose local delete failed stays `done` so only the delete is retried.
          state: current.state === 'done' ? 'done' : permanent ? 'failed' : 'pending',
          attempts,
          nextAttemptAt: t + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1)),
          lastError: (e as Error).message === 'offline' ? null : userMessage(e),
        });
      }
    }
  }

  const engine: UploadQueueEngine = {
    async enqueue(recording) {
      if (recording.chunks.length === 0) throw new Error('A recording needs at least one chunk.');
      const items = await load();
      await persist([
        ...items,
        {
          ...recording,
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
      await update(id, { state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
      await engine.process();
    },
    items: async () => [...(await load())],
    async status(): Promise<UploadQueueStatus> {
      const items = await load();
      const t = now();
      return {
        pending: items.filter((i) => i.state !== 'done').length,
        offline: !network.isOnline(),
        failed: items.filter((i) => i.state === 'failed').length,
        expiringSoon: items.filter((i) => t - i.queuedAt >= RETENTION_WARNING_MS).length,
      };
    },
    async wipe() {
      await running?.catch(() => undefined);
      for (const item of await load()) {
        if (item.sessionId && item.state !== 'done')
          await api.abort(item.sessionId, 'user_stopped').catch(() => undefined);
        await chunks.remove(item.id).catch(() => undefined);
      }
      await persist([]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return engine;
}
