/* eslint-disable @typescript-eslint/no-require-imports */
import { withBackupExclusion } from '../src/record/backupExclusion';
import { createFileChunkStore } from '../src/record/fileChunkStore';
import { createFileQueueStore } from '../src/upload/fileQueueStore';
import { createMemoryFs, testCipher } from './support/memoryFs';

describe('iOS backup exclusion (R4)', () => {
  it('excludes the folder before the first write, then every new folder and file', async () => {
    const base = createMemoryFs();
    const order: string[] = [];
    const exclude = jest.fn((uri: string) => {
      order.push(`exclude:${uri}`);
      return Promise.resolve(true);
    });
    const fs = withBackupExclusion(base, exclude);
    const write = base.writeAsStringAsync.bind(base);
    base.writeAsStringAsync = (u, c, o) => {
      order.push(`write:${u}`);
      return write(u, c, o);
    };
    base.put('file:///cache/a.m4a', Uint8Array.from([1, 2, 3]));
    await createFileChunkStore(fs, testCipher, 2).ingest('rec-1', 'file:///cache/a.m4a');
    await createFileQueueStore(fs).save([]);
    expect(order[0]).toBe('exclude:file:///doc/recordings/');
    const excluded = exclude.mock.calls.map((c) => c[0]);
    // Per new folder and per new file, not once per run.
    expect(excluded).toEqual(
      expect.arrayContaining([
        'file:///doc/recordings/rec-1/',
        'file:///doc/recordings/rec-1/0.chunk',
        'file:///doc/recordings/rec-1/1.chunk',
        'file:///doc/recordings/queue.json',
      ]),
    );
  });

  it('fails closed when the flag cannot be set', async () => {
    const base = createMemoryFs();
    const fs = withBackupExclusion(base, () => Promise.resolve(false));
    base.put('file:///cache/a.m4a', Uint8Array.from([1, 2, 3]));
    await expect(
      createFileChunkStore(fs, testCipher, 2).ingest('rec-1', 'file:///cache/a.m4a'),
    ).rejects.toThrow(/backup/);
    expect([...base.files.keys()].some((k) => k.endsWith('.chunk'))).toBe(false);
  });
});

describe('fail closed without the native module', () => {
  it('reports failure on iOS when the module is missing, so no audio is written', async () => {
    const { iosBackupExclusion } =
      require('../src/record/expoAudio') as typeof import('../src/record/expoAudio');
    const exclude = iosBackupExclusion();
    expect(exclude).not.toBeNull();
    await expect(exclude!('file:///doc/recordings/')).resolves.toBe(false);
    const base = createMemoryFs();
    base.put('file:///cache/a.m4a', Uint8Array.from([1, 2, 3]));
    await expect(
      createFileChunkStore(withBackupExclusion(base, exclude!), testCipher, 2).ingest(
        'rec-1',
        'file:///cache/a.m4a',
      ),
    ).rejects.toThrow(/backup/);
    expect([...base.files.keys()].some((k) => k.endsWith('.chunk'))).toBe(false);
  });
});

describe('per-file exclusion and Start-time failure', () => {
  it('deletes a written file whose exclusion fails', async () => {
    const base = createMemoryFs();
    const fs = withBackupExclusion(base, (uri) => Promise.resolve(!uri.endsWith('.json')));
    await expect(createFileQueueStore(fs).save([])).rejects.toThrow(/backup/);
    expect([...base.files.keys()].some((k) => k.endsWith('.json'))).toBe(false);
  });

  it('re-excludes the folder after it is deleted', async () => {
    const base = createMemoryFs();
    const exclude = jest.fn((uri: string) => Promise.resolve(uri.length > 0));
    const fs = withBackupExclusion(base, exclude);
    const rootCalls = () =>
      exclude.mock.calls.filter((c) => c[0] === 'file:///doc/recordings/').length;
    await createFileQueueStore(fs).save([]);
    const before = rootCalls();
    await fs.deleteAsync('file:///doc/recordings/', { idempotent: true });
    await createFileQueueStore(fs).save([]);
    expect(rootCalls()).toBeGreaterThan(before);
  });

  it('fails at Start without exclusion and removes the empty recorder file', async () => {
    const { createNativeCapture } =
      require('../src/record/nativeCapture') as typeof import('../src/record/nativeCapture');
    const base = createMemoryFs();
    const uri = 'file:///cache/ExpoAudio/rec.m4a';
    const calls: string[] = [];
    const driver = {
      canRecord: () => Promise.resolve(true),
      setRecordingMode: () => Promise.resolve(),
      prepare: () => {
        base.put(uri, new Uint8Array(0));
        return Promise.resolve();
      },
      record: () => void calls.push('record'),
      pause: () => undefined,
      stop: () => Promise.resolve(uri),
      isRecording: () => false,
      currentUri: () => uri,
    };
    const store = createFileChunkStore(
      withBackupExclusion(base, () => Promise.resolve(false)),
      testCipher,
    );
    await expect(createNativeCapture(driver, store).begin('rec-1')).rejects.toThrow(/backup/);
    expect(calls).not.toContain('record');
    expect(base.files.has(uri)).toBe(false);
  });
});
