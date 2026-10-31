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

describe('android foreground service indicator (R2)', () => {
  const indicator = () => {
    const calls: string[] = [];
    let stopListener: () => void = () => undefined;
    return {
      calls,
      press: () => stopListener(),
      start: () => void calls.push('fgs:start'),
      stop: () => void calls.push('fgs:stop'),
      confirmed: true,
      isConfirmed() {
        return this.confirmed;
      },
      onStopRequested: (l: () => void) => {
        stopListener = l;
        return () => undefined;
      },
    };
  };

  it('starts the service before the mic and stops it with capture', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const fgs = indicator();
    const cap = createNativeCapture(driver, createFileChunkStore(fs), fgs);
    expect(cap.isBackgroundSafe?.()).toBe(false);
    await cap.begin('rec-1');
    expect(fgs.calls).toEqual(['fgs:start']);
    expect(cap.isBackgroundSafe?.()).toBe(true);
    fgs.confirmed = false;
    expect(cap.isBackgroundSafe?.()).toBe(false);
    fgs.confirmed = true;
    fs.put(uri, bytes(3));
    await cap.capture('rec-1', 1);
    expect(fgs.calls).toEqual(['fgs:start', 'fgs:stop']);
    const stop = jest.fn();
    cap.onStopRequested?.(stop);
    fgs.press();
    expect(stop).toHaveBeenCalled();
  });

  it('records nothing when the service cannot start', async () => {
    const { driver } = fakeDriver();
    const fgs = {
      ...indicator(),
      start: () => {
        throw new Error('denied');
      },
    };
    const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs()), fgs);
    await expect(cap.begin('rec-1')).rejects.toThrow('denied');
    expect(driver.calls).not.toContain('record');
  });
});

it('keeps the original begin error when stopping the service also throws', async () => {
  const { driver } = fakeDriver({ prepare: () => Promise.reject(new Error('prepare failed')) });
  const fgs = {
    start: () => undefined,
    stop: () => {
      throw new Error('stop failed');
    },
    isConfirmed: () => false,
    onStopRequested: () => () => undefined,
  };
  const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs()), fgs);
  await expect(cap.begin('rec-1')).rejects.toThrow('prepare failed');
});
