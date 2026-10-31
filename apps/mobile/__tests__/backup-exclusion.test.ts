/* eslint-disable @typescript-eslint/no-require-imports */
import { withBackupExclusion } from '../src/record/backupExclusion';
import { createFileChunkStore } from '../src/record/fileChunkStore';
import { createFileQueueStore } from '../src/upload/fileQueueStore';
import { createMemoryFs } from './support/memoryFs';

describe('iOS backup exclusion (R4)', () => {
  it('excludes the recordings folder once, before the first write', async () => {
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
    await createFileChunkStore(fs, 2).ingest('rec-1', 'file:///cache/a.m4a');
    await createFileQueueStore(fs).save([]);
    expect(exclude).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('exclude:file:///doc/recordings/');
  });

  it('fails closed when the flag cannot be set', async () => {
    const base = createMemoryFs();
    const fs = withBackupExclusion(base, () => Promise.resolve(false));
    base.put('file:///cache/a.m4a', Uint8Array.from([1, 2, 3]));
    await expect(
      createFileChunkStore(fs, 2).ingest('rec-1', 'file:///cache/a.m4a'),
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
      createFileChunkStore(withBackupExclusion(base, exclude!), 2).ingest(
        'rec-1',
        'file:///cache/a.m4a',
      ),
    ).rejects.toThrow(/backup/);
    expect([...base.files.keys()].some((k) => k.endsWith('.chunk'))).toBe(false);
  });
});
