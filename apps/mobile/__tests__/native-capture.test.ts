import { base64ToBytes, bytesToBase64 } from '../src/record/base64';
import { createFileChunkStore } from '../src/record/fileChunkStore';
import { createNativeCapture, type AudioDriver } from '../src/record/nativeCapture';
import { sha256Hex } from '../src/record/sha256';
import { createMemoryFs } from './support/memoryFs';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256);

function fakeDriver(over: Partial<AudioDriver> = {}) {
  const calls: string[] = [];
  let recording = false;
  const uri = 'file:///cache/ExpoAudio/rec.m4a';
  const driver: AudioDriver & { calls: string[]; interrupt(): void } = {
    calls,
    interrupt: () => {
      recording = false;
    },
    canRecord: () => Promise.resolve(true),
    setRecordingMode: (a) => {
      calls.push(`mode:${a}`);
      return Promise.resolve();
    },
    prepare: () => {
      calls.push('prepare');
      return Promise.resolve();
    },
    record: () => {
      calls.push('record');
      recording = true;
    },
    pause: () => {
      calls.push('pause');
      recording = false;
    },
    stop: () => {
      calls.push('stop');
      recording = false;
      return Promise.resolve(uri);
    },
    isRecording: () => recording,
    currentUri: () => uri,
    ...over,
  };
  return { driver, uri };
}

describe('base64', () => {
  it('round-trips every length', () => {
    for (const n of [0, 1, 2, 3, 4, 255])
      expect(base64ToBytes(bytesToBase64(bytes(n)))).toEqual(bytes(n));
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(() => base64ToBytes('@@')).toThrow();
  });
});

describe('file chunk store (R4, R6)', () => {
  it('splits a recording into hashed sandbox chunks and deletes the source', async () => {
    const fs = createMemoryFs();
    fs.put('file:///cache/a.m4a', bytes(10));
    const store = createFileChunkStore(fs, 4);
    const chunks = await store.ingest('rec-1', 'file:///cache/a.m4a');
    expect(chunks.map((c) => c.sizeBytes)).toEqual([4, 4, 2]);
    expect(chunks[2]!.sha256).toBe(sha256Hex(bytes(10).subarray(8)));
    expect(fs.files.has('file:///cache/a.m4a')).toBe(false);
    await expect(store.read('rec-1', 1)).resolves.toEqual(bytes(10).subarray(4, 8));
    await expect(store.list()).resolves.toEqual(['rec-1']);
    await store.remove('rec-1');
    await expect(store.exists('rec-1')).resolves.toBe(false);
  });

  it('rejects path-like ids and leaves nothing behind on failure', async () => {
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, 4);
    await expect(store.ingest('../x', 'file:///cache/a.m4a')).rejects.toThrow();
    fs.put('file:///cache/b.m4a', bytes(9));
    fs.readAsStringAsync = () => Promise.reject(new Error('io'));
    await expect(store.ingest('rec-2', 'file:///cache/b.m4a')).rejects.toThrow('io');
    await expect(store.exists('rec-2')).resolves.toBe(false);
    expect(fs.files.has('file:///cache/b.m4a')).toBe(false);
  });
});

describe('native capture (M4)', () => {
  it('never starts without permission (R1)', async () => {
    const { driver } = fakeDriver({ canRecord: () => Promise.resolve(false) });
    const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs()));
    await expect(cap.begin('rec-1')).rejects.toThrow(/permission/);
    expect(driver.calls).toEqual([]);
    expect(cap.isLive()).toBe(false);
  });

  it('records, pauses, resumes, then stops before chunking', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(fs, 4));
    await cap.begin('rec-1');
    expect(cap.isLive()).toBe(true);
    cap.pause();
    expect(cap.isLive()).toBe(true);
    cap.resume();
    fs.put(uri, bytes(6));
    const chunks = await cap.capture('rec-1', 1000);
    expect(chunks).toHaveLength(2);
    expect(driver.calls).toEqual([
      'mode:true',
      'prepare',
      'record',
      'pause',
      'record',
      'stop',
      'mode:false',
    ]);
    expect(cap.isLive()).toBe(false);
    await expect(cap.begin('rec-2')).resolves.toBeUndefined();
  });

  it('reports an interruption instead of resuming by itself (R7)', async () => {
    const { driver } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs()));
    await cap.begin('rec-1');
    driver.interrupt();
    expect(cap.isLive()).toBe(false);
    expect(driver.calls.filter((c) => c === 'record')).toHaveLength(1);
  });

  it('abort stops and deletes the partial file (logout, org switch)', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(fs));
    await cap.begin('rec-1');
    fs.put(uri, bytes(3));
    await cap.abort();
    expect(driver.calls).toContain('stop');
    expect(fs.files.has(uri)).toBe(false);
    await expect(cap.capture('rec-1', 1)).rejects.toThrow();
  });

  it('discards partial output after a crash and never resumes (R7)', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    await createNativeCapture(driver, createFileChunkStore(fs)).begin('rec-1');
    fs.put(uri, bytes(3));
    // Relaunch: a new driver and capture over the same sandbox.
    const { driver: fresh } = fakeDriver({ currentUri: () => null });
    const cap = createNativeCapture(fresh, createFileChunkStore(fs));
    await cap.recoverOnLaunch();
    expect(fs.files.has(uri)).toBe(false);
    expect(fresh.calls).not.toContain('record');
    expect(cap.isLive()).toBe(false);
  });
});

describe('chunk encryption at rest (R5)', () => {
  it('stores sealed chunks and returns plaintext, hashing the plaintext', async () => {
    const fs = createMemoryFs();
    const xor = (b64: string) => bytesToBase64(base64ToBytes(b64).map((v) => v ^ 0x5a));
    const cipher = {
      seal: jest.fn((b: string) => Promise.resolve(xor(b))),
      open: jest.fn((b: string) => Promise.resolve(xor(b))),
    };
    fs.put('file:///cache/a.m4a', bytes(6));
    const store = createFileChunkStore(fs, 4, cipher);
    const chunks = await store.ingest('rec-1', 'file:///cache/a.m4a');
    expect(chunks[0]!.sha256).toBe(sha256Hex(bytes(6).subarray(0, 4)));
    expect(fs.files.get('file:///doc/recordings/rec-1/0.chunk')).not.toEqual(bytes(4));
    await expect(store.read('rec-1', 0)).resolves.toEqual(bytes(6).subarray(0, 4));
    expect(cipher.seal).toHaveBeenCalledTimes(2);
  });
});

describe('encryption fail-closed and legacy migration (R5)', () => {
  const refuse = () => Promise.reject(new Error('unavailable'));

  it('never starts capture when encryption is unavailable', async () => {
    const { driver } = fakeDriver();
    const store = createFileChunkStore(createMemoryFs(), 4, {
      seal: refuse,
      open: refuse,
      ready: refuse,
    });
    const cap = createNativeCapture(driver, store);
    await expect(cap.begin('rec-1')).rejects.toThrow('unavailable');
    expect(driver.calls).not.toContain('record');
  });

  it('never writes plaintext when sealing fails', async () => {
    const fs = createMemoryFs();
    fs.put('file:///cache/a.m4a', bytes(6));
    const store = createFileChunkStore(fs, 4, { seal: refuse, open: refuse });
    await expect(store.ingest('rec-1', 'file:///cache/a.m4a')).rejects.toThrow();
    expect([...fs.files.keys()].some((k) => k.endsWith('.chunk'))).toBe(false);
  });

  it('re-seals plaintext chunks from an older build, on launch and on read', async () => {
    const fs = createMemoryFs();
    const xor = (b64: string) => bytesToBase64(base64ToBytes(b64).map((v) => v ^ 0x5a));
    const cipher = {
      seal: (b: string) => Promise.resolve(xor(b)),
      open: (b: string) => Promise.resolve(xor(b)),
    };
    fs.put('file:///doc/recordings/rec-old/0.chunk', bytes(4));
    fs.put('file:///doc/recordings/rec-old/1.chunk', bytes(3));
    fs.dirs.add('file:///doc/recordings/rec-old/');
    const store = createFileChunkStore(fs, 4, cipher);
    await expect(store.migrateLegacy()).resolves.toBe(2);
    expect(fs.files.get('file:///doc/recordings/rec-old/0.chunk')).not.toEqual(bytes(4));
    await expect(store.migrateLegacy()).resolves.toBe(0);
    await expect(store.read('rec-old', 0)).resolves.toEqual(bytes(4));
    fs.put('file:///doc/recordings/rec-old/2.chunk', bytes(2));
    await expect(store.read('rec-old', 2)).resolves.toEqual(bytes(2));
    expect(fs.files.get('file:///doc/recordings/rec-old/2.chunk')).not.toEqual(bytes(2));
  });
});
