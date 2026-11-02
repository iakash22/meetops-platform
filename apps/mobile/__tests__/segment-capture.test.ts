import { bytesToBase64 } from '../src/record/base64';
import { createFileChunkStore } from '../src/record/fileChunkStore';
import {
  createSegmentCapture,
  SEGMENT_MIME,
  type SegmentRecorder,
} from '../src/record/segmentCapture';
import { sha256Hex } from '../src/record/sha256';
import type { LocalChunk } from '../src/upload/types';
import { createMemoryFs, testCipher } from './support/memoryFs';

// Dummy ADTS frames (7-byte header + filler), never real audio.
const frame = (len: number, fill: number) => {
  const f = new Uint8Array(len).fill(fill);
  f.set([
    0xff,
    0xf1,
    0x50,
    0x80 | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ]);
  return f;
};
const MAGIC = new TextEncoder().encode('MOCHUNK1');

/** Fake native recorder: each "segment" is sealed into <dir><seq>.chunk the moment it closes. */
function fakeNative(fs: ReturnType<typeof createMemoryFs>) {
  let dir: string | null = null;
  let seq = 0;
  let recording = false;
  const sealed: LocalChunk[] = [];
  const plain: Uint8Array[] = [];
  const closeSegment = (bytes: Uint8Array) => {
    const out = new Uint8Array(MAGIC.length + bytes.length);
    out.set(MAGIC);
    out.set(bytes, MAGIC.length);
    fs.put(`${dir}${seq}.chunk`, out); // testCipher is identity
    sealed.push({ seq, sizeBytes: bytes.length, sha256: sha256Hex(bytes) });
    plain.push(bytes);
    seq += 1;
  };
  const native: SegmentRecorder & {
    closeSegment(b: Uint8Array): void;
    openPart(b: Uint8Array): void;
    plain: Uint8Array[];
    calls: string[];
  } = {
    plain,
    calls: [],
    closeSegment,
    openPart: (b) => fs.put(`${dir}${seq}.part`, b),
    start: (d) => {
      native.calls.push('start');
      dir = d;
      recording = true;
      return Promise.resolve();
    },
    pause: () => void (recording = false),
    resume: () => void (recording = true),
    isRecording: () => recording,
    stop: () => {
      native.calls.push('stop');
      recording = false;
      return Promise.resolve([...sealed]);
    },
    abort: () => {
      native.calls.push('abort');
      recording = false;
      if (dir) void fs.deleteAsync(dir, { idempotent: true });
      return Promise.resolve();
    },
    recover: (d) => {
      native.calls.push(`recover:${d}`);
      return Promise.resolve([...sealed]);
    },
  };
  return native;
}

const draft = {
  id: 'rec-1',
  organizationId: 'org-1',
  meetingId: 'm-1',
  mimeType: 'audio/mp4' as const,
  startedAt: '2026-10-31T00:00:00.000Z',
  durationMs: 1,
  consent: {} as never,
};

describe('Android segment capture (ADR-015, R5)', () => {
  const setup = () => {
    const fs = createMemoryFs();
    const store = createFileChunkStore(fs, testCipher);
    const native = fakeNative(fs);
    const indicator = {
      start: jest.fn(),
      stop: jest.fn(),
      isConfirmed: () => true,
      onStopRequested: () => () => undefined,
    };
    const cap = createSegmentCapture(native, store, {
      canRecord: () => Promise.resolve(true),
      indicator,
    });
    return { fs, store, native, cap, indicator };
  };

  it('declares audio/aac and never starts without permission', async () => {
    const { fs, native } = setup();
    const cap = createSegmentCapture(native, createFileChunkStore(fs, testCipher), {
      canRecord: () => Promise.resolve(false),
    });
    expect(cap.outputMimeType).toBe(SEGMENT_MIME);
    await expect(cap.begin('rec-1')).rejects.toThrow(/permission/);
    expect(native.calls).toEqual([]);
  });

  it('only the open segment is ever plaintext: closed segments are sealed chunks on disk', async () => {
    const { fs, native, cap } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    native.closeSegment(frame(33, 2));
    native.openPart(frame(20, 3));
    const files = [...fs.files.keys()].filter((k) => k.includes('/rec-1/'));
    const plaintext = files.filter((k) => k.endsWith('.part'));
    expect(plaintext).toEqual(['file:///doc/recordings/rec-1/2.part']);
    expect(files.filter((k) => k.endsWith('.chunk'))).toHaveLength(2);
  });

  it('Stop returns chunks whose per-chunk and whole-file hashes match the concatenated stream', async () => {
    const { native, cap, store, indicator } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    native.closeSegment(frame(33, 2));
    const chunks = await cap.capture('rec-1', 1000, draft);
    expect(indicator.stop).toHaveBeenCalled();
    const whole = new Uint8Array(native.plain.reduce((n, b) => n + b.length, 0));
    let off = 0;
    for (const [i, c] of chunks.entries()) {
      const body = await store.read('rec-1', c.seq);
      expect(sha256Hex(body)).toBe(c.sha256);
      expect(body).toEqual(native.plain[i]);
      whole.set(body, off);
      off += body.length;
    }
    // What the worker recomputes over the joined bytes.
    expect(sha256Hex(whole)).toBe(
      sha256Hex(Uint8Array.from([...native.plain[0]!, ...native.plain[1]!])),
    );
    expect(bytesToBase64(whole.subarray(0, 2))).toBe(bytesToBase64(Uint8Array.from([0xff, 0xf1])));
    await expect(store.getMarker()).resolves.toBeNull();
    await expect(store.manifest('rec-1')).resolves.toEqual(chunks);
  });

  it('a sealed stop whose native marker write failed resolves, writes the manifest and survives the next launch', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    const sealed = [{ seq: 0, sizeBytes: 40, sha256: sha256Hex(frame(40, 1)) }];
    native.stop = () => Promise.resolve({ chunks: sealed, markerFailed: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(cap.capture('rec-1', 1000, draft)).resolves.toEqual(sealed);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('marker write failed'));
    } finally {
      warn.mockRestore();
    }
    await expect(store.manifest('rec-1')).resolves.toEqual(sealed);
    await expect(store.getMarker()).resolves.toBeNull();
    // Next launch (no sentinel on disk): nothing to recover, nothing discarded.
    const fresh = fakeNative(fs);
    fresh.stoppedNatively = () => false;
    await createSegmentCapture(fresh, store, {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(jest.fn());
    await expect(store.exists('rec-1')).resolves.toBe(true);
    await expect(store.manifest('rec-1')).resolves.toEqual(sealed);
  });

  it('accepts the { chunks, markerFailed: false } stop result without warning', async () => {
    const { native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    const sealed = [{ seq: 0, sizeBytes: 40, sha256: sha256Hex(frame(40, 1)) }];
    native.stop = () => Promise.resolve({ chunks: sealed, markerFailed: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(cap.capture('rec-1', 1000, draft)).resolves.toEqual(sealed);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    await expect(store.manifest('rec-1')).resolves.toEqual(sealed);
  });

  it('a kill during Stop resumes at launch and enqueues as audio/aac', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    native.stop = () => new Promise<LocalChunk[]>(() => undefined); // killed while draining
    void cap.capture('rec-1', 1, draft);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await expect(store.getMarker()).resolves.toMatchObject({
      phase: 'sealing',
      recordingId: 'rec-1',
    });
    const fresh = fakeNative(fs);
    fresh.recover = () =>
      Promise.resolve([{ seq: 0, sizeBytes: 40, sha256: sha256Hex(frame(40, 1)) }]);
    const enqueue = jest.fn(() => Promise.resolve());
    await createSegmentCapture(fresh, createFileChunkStore(fs, testCipher), {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(enqueue);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rec-1', mimeType: 'audio/aac', chunks: [expect.anything()] }),
    );
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('a kill while still recording discards every segment and never resumes (R7)', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    const fresh = fakeNative(fs);
    const enqueue = jest.fn(() => Promise.resolve());
    await createSegmentCapture(fresh, store, {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    expect(fresh.calls).not.toContain('start');
    await expect(store.exists('rec-1')).resolves.toBe(false);
  });

  it('a native Stop (swipe-away, no JS) then a kill keeps the recording sealed and held, never resumed', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    // Process died after the service told the recorder to stop: marker is still `recording`.
    await expect(store.getMarker()).resolves.toMatchObject({ phase: 'recording' });
    const fresh = fakeNative(fs);
    const dirs: string[] = [];
    fresh.stoppedNatively = (d) => {
      dirs.push(d);
      return true;
    };
    fresh.recover = () =>
      Promise.resolve([{ seq: 0, sizeBytes: 40, sha256: sha256Hex(frame(40, 1)) }]);
    const enqueue = jest.fn(() => Promise.resolve());
    await createSegmentCapture(fresh, store, {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(enqueue);
    expect(dirs).toEqual([store.chunkDir('rec-1')]);
    expect(enqueue).not.toHaveBeenCalled(); // no draft yet: held, not uploaded
    expect(fresh.calls).not.toContain('start');
    await expect(store.held()).resolves.toContain('rec-1');
    await expect(store.manifest('rec-1')).resolves.toHaveLength(1);
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('a native Stop that sealed nothing is discarded at launch', async () => {
    const { fs, cap, store } = setup();
    await cap.begin('rec-1');
    const fresh = fakeNative(fs);
    fresh.stoppedNatively = () => true;
    fresh.recover = () => Promise.resolve([]);
    await createSegmentCapture(fresh, store, {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(jest.fn());
    await expect(store.exists('rec-1')).resolves.toBe(false);
    await expect(store.held()).resolves.not.toContain('rec-1');
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('a throwing stoppedNatively falls back to the R7 discard', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    const fresh = fakeNative(fs);
    fresh.stoppedNatively = () => {
      throw new Error('native gone');
    };
    await createSegmentCapture(fresh, store, {
      canRecord: () => Promise.resolve(true),
    }).recoverOnLaunch(jest.fn());
    await expect(store.exists('rec-1')).resolves.toBe(false);
  });

  it('a failed start cleans up and stops the indicator', async () => {
    const { native, cap, store, indicator } = setup();
    native.start = () => Promise.reject(new Error('mic busy'));
    await expect(cap.begin('rec-1')).rejects.toThrow('mic busy');
    expect(indicator.stop).toHaveBeenCalled();
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('abort (logout) deletes the capture', async () => {
    const { native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    await cap.abort();
    await expect(store.exists('rec-1')).resolves.toBe(false);
    await expect(store.getMarker()).resolves.toBeNull();
  });

  it('a stop that fails (native could not clear plaintext) keeps the sealing marker for launch recovery', async () => {
    const { native, cap, store, indicator } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    native.stop = () => Promise.reject(new Error('Plaintext segment could not be removed'));
    await expect(cap.capture('rec-1', 1, draft)).rejects.toThrow(/Plaintext/);
    expect(indicator.stop).toHaveBeenCalled();
    await expect(store.getMarker()).resolves.toMatchObject({
      phase: 'sealing',
      recordingId: 'rec-1',
    });
    await expect(store.exists('rec-1')).resolves.toBe(true);
  });

  it('abort deletes the folder only after native abort (writes stopped, thread joined) has finished', async () => {
    const { fs, native, cap, store } = setup();
    await cap.begin('rec-1');
    native.closeSegment(frame(40, 1));
    const order: string[] = [];
    let finish!: () => void;
    native.abort = () =>
      new Promise<void>((r) => {
        finish = () => {
          order.push('native-abort-done');
          r();
        };
      });
    const remove = store.remove.bind(store);
    store.remove = (id) => {
      order.push('remove');
      return remove(id);
    };
    const done = cap.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
    expect(fs.files.has('file:///doc/recordings/rec-1/0.chunk')).toBe(true);
    finish();
    await done;
    expect(order).toEqual(['native-abort-done', 'remove']);
    await expect(store.exists('rec-1')).resolves.toBe(false);
  });
});
