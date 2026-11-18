import { base64ToBytes, bytesToBase64 } from '../src/record/base64';
import { createFileChunkStore } from '../src/record/fileChunkStore';
import { createNativeCapture, type AudioDriver } from '../src/record/nativeCapture';
import { sha256Hex } from '../src/record/sha256';
import { createMemoryFs, testCipher } from './support/memoryFs';

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
    const store = createFileChunkStore(fs, testCipher, 4);
    const chunks = await store.ingest('rec-1', 'file:///cache/a.m4a');
    expect(chunks.map((c) => c.sizeBytes)).toEqual([4, 4, 2]);
    expect(chunks[2]!.sha256).toBe(sha256Hex(bytes(10).subarray(8)));
    expect(fs.files.has('file:///cache/a.m4a')).toBe(false);
    await expect(store.read('rec-1', 1)).resolves.toEqual(bytes(10).subarray(4, 8));
    await expect(store.list()).resolves.toEqual(['rec-1']);
    await store.remove('rec-1');
    await expect(store.exists('rec-1')).resolves.toBe(false);
  });

  it('rejects path-like ids and keeps the source on failure so launch can resume (crash-safe)', async () => {
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, testCipher, 4);
    await expect(store.ingest('../x', 'file:///cache/a.m4a')).rejects.toThrow();
    fs.put('file:///cache/b.m4a', bytes(9));
    fs.readAsStringAsync = () => Promise.reject(new Error('io'));
    await expect(store.ingest('rec-2', 'file:///cache/b.m4a')).rejects.toThrow('io');
    expect(fs.files.has('file:///cache/b.m4a')).toBe(true);
    await expect(store.manifest('rec-2')).resolves.toBeNull();
  });
});

describe('native capture (M4)', () => {
  it('never starts without permission (R1)', async () => {
    const { driver } = fakeDriver({ canRecord: () => Promise.resolve(false) });
    const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs(), testCipher));
    await expect(cap.begin('rec-1')).rejects.toThrow(/permission/);
    expect(driver.calls).toEqual([]);
    expect(cap.isLive()).toBe(false);
  });

  it('records, pauses, resumes, then stops before chunking', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher, 4));
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
    const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs(), testCipher));
    await cap.begin('rec-1');
    driver.interrupt();
    expect(cap.isLive()).toBe(false);
    expect(driver.calls.filter((c) => c === 'record')).toHaveLength(1);
  });

  it('abort stops and deletes the partial file (logout, org switch)', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher));
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
    await createNativeCapture(driver, createFileChunkStore(fs, testCipher)).begin('rec-1');
    fs.put(uri, bytes(3));
    // Relaunch: a new driver and capture over the same sandbox.
    const { driver: fresh } = fakeDriver({ currentUri: () => null });
    const cap = createNativeCapture(fresh, createFileChunkStore(fs, testCipher));
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
    const store = createFileChunkStore(fs, cipher, 4);
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
    const store = createFileChunkStore(createMemoryFs(), {
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
    const store = createFileChunkStore(fs, { seal: refuse, open: refuse }, 4);
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
    const store = createFileChunkStore(fs, cipher, 4);
    await expect(store.migrateLegacy()).resolves.toBe(2);
    expect(fs.files.get('file:///doc/recordings/rec-old/0.chunk')).not.toEqual(bytes(4));
    await expect(store.migrateLegacy()).resolves.toBe(0);
    await expect(store.read('rec-old', 0)).resolves.toEqual(bytes(4));
    fs.put('file:///doc/recordings/rec-old/2.chunk', bytes(2));
    await expect(store.read('rec-old', 2)).resolves.toEqual(bytes(2));
    expect(fs.files.get('file:///doc/recordings/rec-old/2.chunk')).not.toEqual(bytes(2));
  });
});

describe('android foreground service indicator (R2)', () => {
  const indicator = () => {
    const calls: string[] = [];
    let stopListener: () => void = () => undefined;
    return {
      calls,
      press: () => stopListener(),
      start: () => (calls.push('fgs:start'), 'svc-1'),
      update: () => undefined,
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
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher), fgs);
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
    // Capture already ended: a late or repeated event is ignored.
    fgs.press();
    expect(stop).not.toHaveBeenCalled();
    await cap.begin('rec-2');
    fgs.press();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the service cannot start', async () => {
    const { driver } = fakeDriver();
    const fgs = {
      ...indicator(),
      start: () => {
        throw new Error('denied');
      },
    };
    const cap = createNativeCapture(
      driver,
      createFileChunkStore(createMemoryFs(), testCipher),
      fgs,
    );
    await expect(cap.begin('rec-1')).rejects.toThrow('denied');
    expect(driver.calls).not.toContain('record');
  });

  it('passes the id from start to stop, and refuses to record when start returns no id', async () => {
    const { driver, uri } = fakeDriver();
    const fs = createMemoryFs();
    const seen: string[] = [];
    const fgs = {
      ...indicator(),
      start: () => (seen.push('start'), 'svc-99'),
      stop: (id: string) => seen.push(`stop:${id}`),
    };
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher), fgs);
    await cap.begin('rec-1');
    fs.put(uri, bytes(3));
    await cap.capture('rec-1', 1);
    expect(seen).toEqual(['start', 'stop:svc-99']);

    const empty = {
      ...indicator(),
      start: () => null,
      stop: (id: string) => seen.push(`stop:${id}`),
    };
    const cap2 = createNativeCapture(
      fakeDriver().driver,
      createFileChunkStore(createMemoryFs(), testCipher),
      empty,
    );
    const before = seen.length;
    await expect(cap2.begin('rec-2')).rejects.toThrow(
      'recording notification could not be started',
    );
    expect(seen.length).toBe(before);
  });

  // Tester r4 item 1: a Start that fails right after the service was asked to start must take the
  // "recording" notification down again (native side: RecordingForegroundService.requestStop/markRunningUnlessCancelled).
  it.each([
    [
      'prepare rejects',
      { prepare: () => Promise.reject(new Error('prepare failed')) },
      'prepare failed',
    ],
    ['no output file', { currentUri: () => null }, 'did not create an output file'],
    [
      'audio mode rejects',
      {
        setRecordingMode: (a: boolean) =>
          a ? Promise.reject(new Error('mode')) : Promise.resolve(),
      },
      'mode',
    ],
  ])('a fast Start failure (%s) stops the service it started, once', async (_name, over, msg) => {
    const { driver } = fakeDriver(over);
    const fgs = indicator();
    const cap = createNativeCapture(
      driver,
      createFileChunkStore(createMemoryFs(), testCipher),
      fgs,
    );
    await expect(cap.begin('rec-1')).rejects.toThrow(msg);
    expect(fgs.calls).toEqual(['fgs:start', 'fgs:stop']);
    expect(driver.calls).not.toContain('record');
    expect(cap.isBackgroundSafe?.()).toBe(false);
    // A later notification Stop for the failed start is ignored, and a retry starts cleanly.
    const stop = jest.fn();
    cap.onStopRequested?.(stop);
    fgs.press();
    expect(stop).not.toHaveBeenCalled();
  });

  it('a protect failure after the service started also stops it', async () => {
    const { driver } = fakeDriver();
    const fgs = indicator();
    const cap = createNativeCapture(
      driver,
      createFileChunkStore(createMemoryFs(), testCipher),
      fgs,
      {
        recorderFiles: { protect: () => Promise.resolve(false), sweep: () => Promise.resolve(0) },
      },
    );
    await expect(cap.begin('rec-1')).rejects.toThrow('Could not protect');
    expect(fgs.calls).toEqual(['fgs:start', 'fgs:stop']);
  });

  it('a failure before the service starts never touches it', async () => {
    const { driver } = fakeDriver({ canRecord: () => Promise.resolve(false) });
    const fgs = indicator();
    const cap = createNativeCapture(
      driver,
      createFileChunkStore(createMemoryFs(), testCipher),
      fgs,
    );
    await expect(cap.begin('rec-1')).rejects.toThrow('Microphone permission');
    expect(fgs.calls).toEqual([]);
  });
});

it('keeps the original begin error when stopping the service also throws', async () => {
  const { driver } = fakeDriver({ prepare: () => Promise.reject(new Error('prepare failed')) });
  const fgs = {
    start: () => 'svc-1',
    update: () => undefined,
    stop: () => {
      throw new Error('stop failed');
    },
    isConfirmed: () => false,
    onStopRequested: () => () => undefined,
  };
  const cap = createNativeCapture(driver, createFileChunkStore(createMemoryFs(), testCipher), fgs);
  await expect(cap.begin('rec-1')).rejects.toThrow('prepare failed');
});

describe('r3: one file per recording, sealed before the marker clears', () => {
  it('keeps consecutive recordings intact when the driver reuses the same output path (H-1)', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const store = createFileChunkStore(fs, testCipher, 4);
    const cap = createNativeCapture(driver, store);
    await cap.begin('rec-1');
    fs.put(uri, bytes(6));
    await cap.capture('rec-1', 1);
    await cap.begin('rec-2');
    fs.put(uri, Uint8Array.from([9, 9, 9]));
    await cap.capture('rec-2', 1);
    await expect(store.read('rec-1', 0)).resolves.toEqual(bytes(6).subarray(0, 4));
    await expect(store.read('rec-1', 1)).resolves.toEqual(bytes(6).subarray(4, 6));
    await expect(store.read('rec-2', 0)).resolves.toEqual(Uint8Array.from([9, 9, 9]));
    expect(fs.files.has(uri)).toBe(false);
  });

  it('clears the in-progress marker only after the file is sealed (M-1)', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const store = createFileChunkStore(fs, testCipher, 4);
    const seen: (string | null)[] = [];
    const ingest = store.ingest.bind(store);
    store.ingest = async (id, src) => {
      seen.push(await store.getInProgress());
      return ingest(id, src);
    };
    const cap = createNativeCapture(driver, store);
    await cap.begin('rec-1');
    fs.put(uri, bytes(3));
    await cap.capture('rec-1', 1);
    expect(seen).toEqual([uri]);
    await expect(store.getInProgress()).resolves.toBeNull();
  });

  it('protects the recorder file after prepare and fails closed when it cannot', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver({
      prepare: () => {
        fs.put(uri, new Uint8Array(0));
        return Promise.resolve();
      },
    });
    const protect = jest.fn(() => Promise.resolve(false));
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher), null, {
      recorderFiles: { protect, sweep: () => Promise.resolve(0) },
    });
    await expect(cap.begin('rec-1')).rejects.toThrow(/protect/);
    expect(protect).toHaveBeenCalledWith(uri);
    expect(driver.calls).not.toContain('record');
    expect(fs.files.has(uri)).toBe(false);
  });

  it('sweeps leftover recorder files from the cache at launch', async () => {
    const { createRecorderFileGuard } = jest.requireActual<
      typeof import('../src/record/recorderFiles')
    >('../src/record/recorderFiles');
    const fs = createMemoryFs();
    fs.put('file:///cache/ExpoAudio/old.m4a', bytes(3));
    fs.put('file:///cache/Audio/recording-1.m4a', bytes(3));
    fs.put('file:///cache/recording-1.m4a', bytes(3));
    fs.put('file:///cache/OtherLib/clip.m4a', bytes(3));
    fs.put('file:///cache/other.json', bytes(1));
    fs.put('file:///doc/recordings/rec-1/0.chunk', bytes(1));
    const guard = createRecorderFileGuard(fs, 'file:///cache/', null);
    const { driver } = fakeDriver();
    await createNativeCapture(driver, createFileChunkStore(fs, testCipher), null, {
      recorderFiles: guard,
    }).recoverOnLaunch();
    expect(fs.files.has('file:///cache/ExpoAudio/old.m4a')).toBe(false);
    expect(fs.files.has('file:///cache/Audio/recording-1.m4a')).toBe(false);
    // Scoped to expo-audio's folders only: other cache files are not ours.
    expect(fs.files.has('file:///cache/recording-1.m4a')).toBe(true);
    expect(fs.files.has('file:///cache/OtherLib/clip.m4a')).toBe(true);
    expect(fs.files.has('file:///cache/other.json')).toBe(true);
    expect(fs.files.has('file:///doc/recordings/rec-1/0.chunk')).toBe(true);
    await expect(guard.protect('x')).resolves.toBe(true);
  });
});

describe('Tester r4 mobile hardening', () => {
  const draft = {
    id: 'rec-1',
    organizationId: 'org-1',
    meetingId: 'm-1',
    mimeType: 'audio/mp4' as const,
    startedAt: '2026-10-31T00:00:00.000Z',
    durationMs: 1,
    consent: {} as never,
  };

  it('begin waits for the launch sweep, so it can never delete the live recorder file', async () => {
    const { createRecorderFileGuard } = jest.requireActual<
      typeof import('../src/record/recorderFiles')
    >('../src/record/recorderFiles');
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver({
      prepare: () => {
        fs.put(uri, bytes(2));
        return Promise.resolve();
      },
    });
    const real = createRecorderFileGuard(fs, 'file:///cache/', null);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const guard = {
      protect: (u: string) => real.protect(u),
      sweep: async (k?: readonly string[]) => (await gate, real.sweep(k)),
    };
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher), null, {
      recorderFiles: guard,
    });
    const rec = cap.recoverOnLaunch();
    const started = cap.begin('rec-1');
    await Promise.resolve();
    expect(driver.calls).not.toContain('prepare');
    release();
    await rec;
    await started;
    expect(fs.files.has(uri)).toBe(true);
    expect(cap.recoverOnLaunch()).toBe(rec);
  });

  it('a kill mid-seal keeps the recording: launch resumes sealing and enqueues it', async () => {
    const fs = createMemoryFs();
    const { driver, uri } = fakeDriver();
    const cap = createNativeCapture(driver, createFileChunkStore(fs, testCipher, 4));
    await cap.begin('rec-1');
    fs.put(uri, bytes(10));
    const read = fs.readAsStringAsync.bind(fs);
    fs.readAsStringAsync = (u, o) =>
      u === uri && o.position === 4 ? Promise.reject(new Error('killed')) : read(u, o);
    await expect(cap.capture('rec-1', 1, draft)).rejects.toThrow('killed');
    expect(fs.files.has(uri)).toBe(true);
    fs.readAsStringAsync = read;
    const { driver: fresh } = fakeDriver({ currentUri: () => null });
    const store = createFileChunkStore(fs, testCipher, 4);
    const enqueue = jest.fn(() => Promise.resolve());
    await createNativeCapture(fresh, store).recoverOnLaunch(enqueue);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rec-1', meetingId: 'm-1' }),
    );
    expect((enqueue.mock.calls[0] as unknown as [{ chunks: unknown[] }])[0].chunks).toHaveLength(3);
    expect(fs.files.has(uri)).toBe(false);
    await expect(store.getMarker()).resolves.toBeNull();
    expect(fresh.calls).not.toContain('record');
  });

  it('without a draft the resealed recording is held (encrypted), not deleted as an orphan', async () => {
    const { reconcileOrphans } = jest.requireActual<typeof import('../src/upload/uploadScheduler')>(
      '../src/upload/uploadScheduler',
    );
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, testCipher, 4);
    fs.put('file:///cache/Audio/r.m4a', bytes(5));
    await store.setMarker({
      uri: 'file:///cache/Audio/r.m4a',
      phase: 'sealing',
      recordingId: 'rec-9',
    });
    const { driver } = fakeDriver({ currentUri: () => null });
    await createNativeCapture(driver, store).recoverOnLaunch();
    await expect(store.held()).resolves.toEqual(['rec-9']);
    await reconcileOrphans({ items: () => Promise.resolve([]) }, store);
    await expect(store.exists('rec-9')).resolves.toBe(true);
  });

  it('gives up after repeated failed resumes and deletes the plaintext', async () => {
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, testCipher, 4);
    fs.put('file:///cache/Audio/r.m4a', bytes(5));
    await store.setMarker({
      uri: 'file:///cache/Audio/r.m4a',
      phase: 'sealing',
      recordingId: 'rec-8',
      attempts: 3,
    });
    const { driver } = fakeDriver({ currentUri: () => null });
    await createNativeCapture(driver, store).recoverOnLaunch(() => Promise.resolve());
    expect(fs.files.has('file:///cache/Audio/r.m4a')).toBe(false);
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('uses the native file sealer when the cipher provides one', async () => {
    const fs = createMemoryFs();
    fs.put('file:///cache/Audio/a.m4a', bytes(6));
    const sealFile = jest.fn(() => Promise.resolve([{ seq: 0, sizeBytes: 6, sha256: 'x' }]));
    const store = createFileChunkStore(fs, { ...testCipher, sealFile }, 4);
    await expect(store.ingest('rec-1', 'file:///cache/Audio/a.m4a')).resolves.toHaveLength(1);
    expect(sealFile).toHaveBeenCalledWith(
      'file:///cache/Audio/a.m4a',
      'file:///doc/recordings/rec-1/',
      4,
    );
    expect(fs.files.has('file:///cache/Audio/a.m4a')).toBe(false);
    await expect(store.manifest('rec-1')).resolves.toHaveLength(1);
  });

  it('reads the bare-uri marker written by older builds as still recording', async () => {
    const fs = createMemoryFs();
    fs.put(
      'file:///doc/recordings/in-progress.uri',
      new TextEncoder().encode('file:///cache/Audio/o.m4a'),
    );
    const store = createFileChunkStore(fs, testCipher);
    await expect(store.getMarker()).resolves.toEqual({
      uri: 'file:///cache/Audio/o.m4a',
      phase: 'recording',
    });
  });
});
