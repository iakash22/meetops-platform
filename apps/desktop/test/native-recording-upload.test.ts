import { describe, expect, it } from 'vitest';

import { createNativeChunkStore } from '@/features/recording/native-chunk-store';
import { createNativeUploadApi, type Invoke } from '@/features/recording/native-upload-api';
import { META_INDEX } from '@/features/recording/native-chunk-store';
import {
  RETENTION_MS,
  createMemoryLedger,
  createUploadQueue,
  type RecordingLedger,
  type NewRecording,
  type QueueContext,
} from '@/features/recording/upload-queue';

/** Shaped like Rust's `{ code, message }` rejection. */
const rustError = (code: string) => Object.assign(new Error(code), { code });

/**
 * Fake Tauri backend sharing one "disk" across store/queue instances (= app restarts). Like Rust, the chunk owner
 * comes from the backend's own session (`rust.signedIn`), never from the webview; tombstones are device-wide.
 */
function fakeRust(opts: { failPutsOnce?: number; metaDelayMs?: () => number } = {}) {
  const disk = new Map<string, number[]>();
  const tombs = new Set<string>();
  const pins = new Map<string, string>();
  const calls: { cmd: string; args: unknown; headers?: HeadersInit | undefined }[] = [];
  let failPuts = opts.failPutsOnce ?? 0;
  const state = {
    signedIn: 'u1:o1' as string | null,
    failDeletes: 0,
    failTombstones: 0,
    /** Only the device-wide tombstone dir fails; the per-recording pin marker still works (L-6). */
    tombDirBroken: false,
  };
  const pinDiscarded = new Set<string>();
  const discarded = (id: string) => tombs.has(id) || pinDiscarded.has(id);
  const invoke = (async (cmd: string, args?: unknown, o?: { headers: HeadersInit }) => {
    calls.push({ cmd, args, headers: o?.headers });
    const a = (args ?? {}) as { sessionId: string; index: number; data: number[]; path: string };
    const owner = () => {
      if (!state.signedIn) throw rustError('UNAUTHENTICATED');
      return state.signedIn;
    };
    // Like Rust: a recording is pinned to its first owner; other owners get FORBIDDEN (L-4).
    const pinned = (create: boolean) => {
      const o = owner();
      const p = pins.get(a.sessionId);
      if (p && p !== o) throw rustError('FORBIDDEN');
      if (!p && create) pins.set(a.sessionId, o);
    };
    const dir = () => `${owner()}/${a.sessionId}/`;
    if (cmd.startsWith('chunk_') && cmd !== 'chunk_list' && cmd !== 'chunk_tombstone')
      pinned(cmd === 'chunk_put');
    switch (cmd) {
      case 'chunk_put':
        if (discarded(a.sessionId)) throw rustError('VALIDATION_FAILED');
        if (a.index === META_INDEX && opts.metaDelayMs)
          await new Promise((r) => setTimeout(r, opts.metaDelayMs?.()));
        disk.set(`${dir()}${a.index}`, a.data);
        return null;
      case 'chunk_get': {
        if (discarded(a.sessionId)) throw rustError('VALIDATION_FAILED');
        const v = disk.get(`${dir()}${a.index}`);
        if (!v) throw rustError('NOT_FOUND');
        return v;
      }
      case 'chunk_delete': {
        const d = dir();
        if (state.failDeletes > 0) {
          state.failDeletes -= 1;
          throw rustError('INTERNAL');
        }
        for (const k of [...disk.keys()]) if (k.startsWith(d)) disk.delete(k);
        if (pins.get(a.sessionId) === owner()) {
          tombs.delete(a.sessionId);
          pinDiscarded.delete(a.sessionId);
          pins.delete(a.sessionId);
        }
        return null;
      }
      case 'chunk_exists': {
        const d = dir();
        return [...disk.keys()].some((k) => k.startsWith(d));
      }
      case 'chunk_list': {
        const p = `${owner()}/`;
        const ids = [
          ...new Set(
            [...disk.keys()].filter((k) => k.startsWith(p)).map((k) => k.split('/')[1] ?? ''),
          ),
        ].sort();
        return ids.map((id) => ({ id, discarded: discarded(id) }));
      }
      case 'chunk_tombstone':
        owner();
        if (state.failTombstones > 0) {
          state.failTombstones -= 1;
          throw rustError('INTERNAL'); // e.g. read-only discarded/ dir
        }
        if (pins.has(a.sessionId)) pinDiscarded.add(a.sessionId);
        if (!state.tombDirBroken) tombs.add(a.sessionId);
        else if (!pins.has(a.sessionId)) throw rustError('INTERNAL');
        return null;
      case 'api_request':
        if (a.path.endsWith('/chunks'))
          return { upload: { url: 'https://storage.example/put', method: 'PUT', headers: {} } };
        if (a.path.includes('/recording-sessions') && !a.path.includes('/rs_1'))
          return { sessionId: 'rs_1' };
        return {};
      case 'upload_put':
        if (failPuts > 0) {
          failPuts -= 1;
          throw rustError('NETWORK');
        }
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  }) as Invoke;
  return { invoke, disk, tombs, calls, state };
}

type Rust = ReturnType<typeof fakeRust>;

/** Queue identity follows the fake backend's session, as the real app's session does. */
const ctxFor = (rust: Rust, online = true): QueueContext => ({
  isOnline: () => online,
  identity: () => {
    const [userId, organizationId] = (rust.state.signedIn ?? '').split(':');
    return userId && organizationId ? { userId, organizationId } : null;
  },
});

const launch = (rust: Rust, now: () => number, online = true, ledger?: RecordingLedger) => {
  const chunks = createNativeChunkStore(rust.invoke);
  const ctx = { ...ctxFor(rust, online), ...(ledger ? { ledger } : {}) };
  return { chunks, queue: createUploadQueue(createNativeUploadApi(rust.invoke), chunks, ctx, now) };
};

const brokenLedger: RecordingLedger = {
  mark: () => {
    throw new Error('quota');
  },
  get: () => null,
  clear: () => undefined,
};

const rec = (id: string, userId = 'u1'): NewRecording => ({
  id,
  userId,
  organizationId: 'o1',
  meetingId: 'm1',
  meetingTitle: 'Standup',
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-28T00:00:00.000Z',
  durationMs: 1000,
  chunks: [
    { seq: 0, sizeBytes: 3, sha256: 'a'.repeat(64) },
    { seq: 1, sizeBytes: 3, sha256: 'b'.repeat(64) },
  ],
  consent: {} as NewRecording['consent'],
});

async function record(chunks: ReturnType<typeof createNativeChunkStore>, id: string) {
  await chunks.put(id, 0, new Uint8Array([1, 2, 3]));
  await chunks.put(id, 1, new Uint8Array([4, 5, 6]));
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const puts = (rust: Rust) => rust.calls.filter((c) => c.cmd === 'upload_put').length;

describe('native recording upload', () => {
  it('stores chunks via the encrypted Rust store and round-trips bytes', async () => {
    const rust = fakeRust();
    const store = createNativeChunkStore(rust.invoke);
    await store.put('r1', 0, new Uint8Array([1, 2, 3]));
    expect(await store.read('r1', 0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.exists('r1')).toBe(true);
    await store.remove('r1');
    expect(await store.exists('r1')).toBe(false);
  });

  it('never sends an owner from the webview (Rust derives it from its session)', async () => {
    const rust = fakeRust();
    const { chunks } = launch(rust, () => 0);
    await chunks.put('r1', 0, new Uint8Array([1]));
    await chunks.exists('r1');
    await chunks.list();
    expect(
      rust.calls.every((c) => !(c.args && typeof c.args === 'object' && 'owner' in c.args)),
    ).toBe(true);
    rust.state.signedIn = null;
    await expect(chunks.put('r1', 1, new Uint8Array([1]))).rejects.toThrow();
  });

  it('sends raw bytes to upload_put with the header, resumes after a failure, then deletes local chunks', async () => {
    const rust = fakeRust({ failPutsOnce: 1 });
    let t = 0;
    const { chunks, queue } = launch(rust, () => t);
    await record(chunks, 'r1');
    queue.enqueue(rec('r1'));
    await queue.process();
    expect(queue.items()[0]?.state).toBe('pending');
    expect(queue.items()[0]?.lastError).toBeTruthy();
    t = 60_000;
    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
    const p = rust.calls.filter((c) => c.cmd === 'upload_put');
    expect(p).toHaveLength(3);
    expect(p[0]?.args).toBeInstanceOf(Uint8Array);
    const h = p[0]?.headers as Record<string, string> | undefined;
    expect(JSON.parse(h?.['x-meetops-upload'] ?? '{}').url).toBe('https://storage.example/put');
  });

  it('re-queues a recording left on disk by an earlier launch and uploads it', async () => {
    const rust = fakeRust({ failPutsOnce: 1 });
    let t = 0;
    const first = launch(rust, () => t);
    await record(first.chunks, 'r1');
    first.queue.enqueue(rec('r1'));
    await first.queue.process();
    await flush();
    t = 60_000;
    const second = launch(rust, () => t);
    expect(await second.chunks.exists('r1')).toBe(true);
    await second.queue.process();
    expect(second.queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
  });

  it('M-1a: a discard whose delete fails is never uploaded after a restart', async () => {
    const rust = fakeRust();
    const first = launch(rust, () => 0, false);
    await record(first.chunks, 'r1');
    first.queue.enqueue(rec('r1'));
    await flush();
    rust.state.failDeletes = 1;
    await first.queue.discard('r1');
    expect(first.queue.items()[0]?.pendingDelete).toBe(true);

    const second = launch(rust, () => 0); // restart, online
    await second.queue.process();
    expect(puts(rust)).toBe(0);
    expect(second.queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
    expect(rust.tombs.size).toBe(0);
  });

  it("M-1b: account B discarding A's recording sticks; A signs in after restart and it is deleted, not uploaded", async () => {
    const rust = fakeRust();
    const first = launch(rust, () => 0, false);
    await record(first.chunks, 'rA');
    first.queue.enqueue(rec('rA'));
    await flush();
    rust.state.signedIn = 'u2:o1'; // B signs in on the same launch
    await first.queue.discard('rA');
    expect([...rust.disk.keys()].some((k) => k.startsWith('u1:o1/rA/'))).toBe(true);

    rust.state.signedIn = 'u1:o1'; // restart, A signs in
    const second = launch(rust, () => 0);
    await second.queue.process();
    expect(puts(rust)).toBe(0);
    expect(rust.disk.size).toBe(0);
  });

  it('deletes leftovers with no metadata and expires old recordings on startup', async () => {
    const rust = fakeRust();
    const c = createNativeChunkStore(rust.invoke);
    await c.put('orphan', 0, new Uint8Array([1]));
    await c.saveMeta(
      'old',
      JSON.stringify({
        ...rec('old'),
        state: 'pending',
        sessionId: null,
        uploadedSeqs: [],
        attempts: 0,
        nextAttemptAt: 0,
        queuedAt: 0,
        lastError: null,
      }),
    );
    const { queue } = launch(rust, () => RETENTION_MS + 1);
    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
    expect(puts(rust)).toBe(0);
  });

  it('retries failed deletes with backoff, capped per launch (L-3, N-2)', async () => {
    const rust = fakeRust();
    let t = 0;
    const { chunks, queue } = launch(rust, () => t, false);
    await record(chunks, 'd1');
    queue.enqueue(rec('d1'));
    rust.state.failDeletes = 100;
    await queue.discard('d1');
    const deletes = () => rust.calls.filter((c) => c.cmd === 'chunk_delete').length;
    await queue.process(); // within backoff: no retry
    expect(deletes()).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      t += 60 * 60 * 1000;
      await queue.process();
    }
    expect(deletes()).toBe(8); // MAX_ATTEMPTS
    expect(queue.items()[0]?.pendingDelete).toBe(true);
    rust.state.failDeletes = 0;
    const again = launch(rust, () => t); // next launch: tombstone makes it delete-only
    await again.queue.process();
    expect(rust.disk.size).toBe(0);
    expect(puts(rust)).toBe(0);
  });

  it('N-3: metadata writes are serialized and none lands after the delete', async () => {
    const rust = fakeRust();
    const { chunks, queue } = launch(rust, () => 0);
    await record(chunks, 'r1');
    queue.enqueue(rec('r1'));
    await queue.process(); // many patches → many saves, then delete
    await flush();
    await flush();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
  });

  it('M-1b: own recording, tombstone + delete + ledger all fail: discard reports it, and a restart never uploads', async () => {
    const rust = fakeRust();
    const first = launch(rust, () => 0, false, brokenLedger);
    await record(first.chunks, 'r1');
    first.queue.enqueue(rec('r1'));
    await flush();
    rust.state.failTombstones = 1;
    rust.state.failDeletes = 1;
    await expect(first.queue.discard('r1')).rejects.toThrow(/may still upload/);
    expect(first.queue.items()[0]?.pendingDelete).toBe(true);
    expect(first.queue.items()[0]?.lastError).toMatch(/may still upload/);

    const second = launch(rust, () => 0, true, brokenLedger); // restart, online
    await second.queue.process();
    expect(puts(rust)).toBe(0);
    expect(rust.disk.size).toBe(0);
  });

  it("M-1b: B discards A's recording while the tombstone write fails: reported, held, retried; never uploaded", async () => {
    const rust = fakeRust();
    const ledger = createMemoryLedger(); // stands in for localStorage (survives restart)
    const first = launch(rust, () => 0, false, ledger);
    await record(first.chunks, 'rA');
    first.queue.enqueue(rec('rA'));
    await flush();
    rust.state.signedIn = 'u2:o1';
    rust.state.failTombstones = 1;
    await first.queue.discard('rA'); // durable via the ledger: no error, honest cleanup message
    expect(first.queue.items()[0]?.lastError).toMatch(/Discard saved/);
    expect(first.queue.items()[0]?.tombstoned).toBeFalsy();
    await first.queue.process(); // tombstone retried
    expect(first.queue.items()[0]?.tombstoned).toBe(true);

    rust.state.signedIn = 'u1:o1';
    rust.tombs.clear(); // even with the tombstone lost, the ledger keeps it delete-only
    const second = launch(rust, () => 0, true, ledger);
    await second.queue.process();
    expect(puts(rust)).toBe(0);
    expect(rust.disk.size).toBe(0);
  });

  it('M-2 stress: upload done + failed delete + restart, x10 with slow metadata writes: zero re-uploads', async () => {
    for (let run = 0; run < 10; run += 1) {
      const rust = fakeRust({ metaDelayMs: () => Math.floor(Math.random() * 15) });
      let t = 0;
      const first = launch(rust, () => t); // per-launch in-memory ledger: relies on the awaited 'done' metadata
      await record(first.chunks, `r${run}`);
      first.queue.enqueue(rec(`r${run}`));
      await new Promise((r) => setTimeout(r, 20));
      rust.state.failDeletes = 1;
      await first.queue.process();
      expect(puts(rust)).toBe(2);
      expect(first.queue.items()[0]?.state).toBe('done');
      t = 60_000;
      const second = launch(rust, () => t);
      await second.queue.process();
      expect(puts(rust)).toBe(2);
      expect(
        rust.calls.filter(
          (c) =>
            c.cmd === 'api_request' &&
            String((c.args as { path: string }).path).endsWith('/complete'),
        ).length,
      ).toBe(1);
      expect(rust.disk.size).toBe(0);
    }
  });

  it('L-4: a recording is pinned to its first owner; an owner change mid-recording is refused', async () => {
    const rust = fakeRust();
    const c = createNativeChunkStore(rust.invoke);
    await c.put('r1', 0, new Uint8Array([1]));
    rust.state.signedIn = 'u1:o2';
    await expect(c.put('r1', 1, new Uint8Array([2]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect([...rust.disk.keys()].every((k) => k.startsWith('u1:o1/'))).toBe(true);
  });

  it("L-6: B discards A's recording with the ledger and the tombstone dir both broken: the pin marker holds it", async () => {
    const rust = fakeRust();
    const first = launch(rust, () => 0, false, brokenLedger);
    await record(first.chunks, 'rA');
    first.queue.enqueue(rec('rA'));
    await flush();
    rust.state.signedIn = 'u2:o1';
    rust.state.tombDirBroken = true;
    await first.queue.discard('rA'); // durable via the pin marker
    expect(first.queue.items()[0]?.tombstoned).toBe(true);
    expect(rust.tombs.size).toBe(0);

    rust.state.signedIn = 'u1:o1'; // restart before any retry
    const second = launch(rust, () => 0, true, brokenLedger);
    await second.queue.process();
    expect(puts(rust)).toBe(0);
    expect(rust.disk.size).toBe(0);
  });
});
