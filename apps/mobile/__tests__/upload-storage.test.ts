import { createFileChunkStore } from '../src/record/fileChunkStore';
import { createFileQueueStore } from '../src/upload/fileQueueStore';
import { createSimulatedUploadApi } from '../src/upload/simulatedUploadApi';
import type { QueueItem } from '../src/upload/types';
import { createUploadQueueEngine, type QueueLogEvent } from '../src/upload/uploadQueueEngine';
import { reconcileOrphans, startUploadScheduler } from '../src/upload/uploadScheduler';
import { createMemoryFs } from './support/memoryFs';

const consent = {
  version: '2026-10-01',
  method: 'all_parties_notified',
  confirmedAt: '2026-10-31T10:00:00.000Z',
} as unknown as QueueItem['consent'];

async function seed(fs: ReturnType<typeof createMemoryFs>, id: string) {
  fs.put(`file:///cache/${id}.m4a`, Uint8Array.from([1, 2, 3, 4, 5]));
  return createFileChunkStore(fs, 2).ingest(id, `file:///cache/${id}.m4a`);
}

function newEngine(fs: ReturnType<typeof createMemoryFs>, log?: (e: QueueLogEvent) => void) {
  return createUploadQueueEngine({
    store: createFileQueueStore(fs),
    chunks: createFileChunkStore(fs, 2),
    api: createSimulatedUploadApi(0),
    network: { isOnline: () => false },
    ...(log ? { log } : {}),
  });
}

const recording = (id: string, chunks: QueueItem['chunks']) => ({
  id,
  organizationId: 'org-1',
  meetingId: '00000000-0000-4000-8000-000000000001',
  mimeType: 'audio/mp4' as const,
  startedAt: '2026-10-31T10:00:00.000Z',
  durationMs: 1000,
  chunks,
  consent,
});

describe('durable queue store (M5)', () => {
  it('keeps queued recordings across a restart, without audio in the metadata', async () => {
    const fs = createMemoryFs();
    const chunks = await seed(fs, 'rec-1');
    await newEngine(fs).enqueue(recording('rec-1', chunks));
    const restarted = newEngine(fs);
    const [item] = await restarted.items();
    expect(item).toMatchObject({ id: 'rec-1', state: 'pending', chunks });
    const raw = new TextDecoder().decode(fs.files.get('file:///doc/recordings/queue.json'));
    expect(raw).not.toMatch(/token|https?:/i);
    expect(fs.files.has('file:///doc/recordings/queue.json.tmp')).toBe(false);
  });

  it('falls back to an empty queue on a corrupt file', async () => {
    const fs = createMemoryFs();
    fs.put('file:///doc/recordings/queue.json', new TextEncoder().encode('{nope'));
    await expect(createFileQueueStore(fs).load()).resolves.toEqual([]);
  });
});

describe('relaunch reconciliation (R4, R6)', () => {
  it('deletes chunk folders with no queue entry and keeps queued ones', async () => {
    const fs = createMemoryFs();
    const engine = newEngine(fs);
    await engine.enqueue(recording('rec-1', await seed(fs, 'rec-1')));
    await seed(fs, 'rec-orphan');
    const store = createFileChunkStore(fs, 2);
    await store.setInProgress('file:///cache/x.m4a');
    await expect(reconcileOrphans(engine, store)).resolves.toEqual(['rec-orphan']);
    await expect(store.exists('rec-1')).resolves.toBe(true);
    await expect(store.exists('rec-orphan')).resolves.toBe(false);
    await expect(store.getInProgress()).resolves.toBe('file:///cache/x.m4a');
  });
});

describe('verified deletion log (R6)', () => {
  it('logs ids only after upload, discard and wipe', async () => {
    const fs = createMemoryFs();
    const events: QueueLogEvent[] = [];
    const engine = createUploadQueueEngine({
      store: createFileQueueStore(fs),
      chunks: createFileChunkStore(fs, 2),
      api: createSimulatedUploadApi(0),
      network: { isOnline: () => true },
      log: (e) => events.push(e),
    });
    await engine.enqueue(recording('rec-1', await seed(fs, 'rec-1')));
    await engine.process();
    await engine.enqueue(recording('rec-2', await seed(fs, 'rec-2')));
    await engine.discard('rec-2');
    expect(events).toEqual([
      { type: 'uploaded', recordingId: 'rec-1', chunkCount: 3 },
      { type: 'deleted', recordingId: 'rec-1', reason: 'uploaded' },
      { type: 'deleted', recordingId: 'rec-2', reason: 'discarded' },
    ]);
    expect([...fs.files.keys()].filter((k) => k.endsWith('.chunk'))).toEqual([]);
  });
});

describe('upload scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs at launch, on foreground and on an interval, never in the background', () => {
    const process = jest.fn(() => Promise.resolve());
    let listener: (s: string) => void = () => undefined;
    const remove = jest.fn();
    const stop = startUploadScheduler(
      { process },
      {
        currentState: 'active',
        addEventListener: (_t, l) => {
          listener = l;
          return { remove };
        },
      },
      1000,
    );
    expect(process).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2000);
    expect(process).toHaveBeenCalledTimes(3);
    listener('background');
    jest.advanceTimersByTime(5000);
    expect(process).toHaveBeenCalledTimes(3);
    listener('active');
    expect(process).toHaveBeenCalledTimes(4);
    stop();
    jest.advanceTimersByTime(5000);
    expect(process).toHaveBeenCalledTimes(4);
    expect(remove).toHaveBeenCalled();
  });
});

describe('logout wipe surfaces failed deletes (Low)', () => {
  it('retries a failed delete once, then throws with the ids and keeps the queue empty', async () => {
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, 2);
    let removes = 0;
    const chunks = {
      ...store,
      remove: (id: string) => {
        removes += 1;
        return id === 'rec-stuck' ? Promise.resolve() : store.remove(id);
      },
    };
    const engine = createUploadQueueEngine({
      store: createFileQueueStore(fs),
      chunks,
      api: createSimulatedUploadApi(0),
      network: { isOnline: () => false },
    });
    await engine.enqueue(recording('rec-ok', await seed(fs, 'rec-ok')));
    await engine.enqueue(recording('rec-stuck', await seed(fs, 'rec-stuck')));
    await expect(engine.wipe()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      recordingIds: ['rec-stuck'],
    });
    expect(removes).toBe(3);
    await expect(engine.items()).resolves.toEqual([]);
    // Next launch: the leftover has no queue entry, so reconciliation deletes it.
    await expect(reconcileOrphans(engine, store)).resolves.toEqual(['rec-stuck']);
  });
});
