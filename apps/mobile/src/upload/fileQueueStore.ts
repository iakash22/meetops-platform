import type { FileSystemLike } from '../record/fileChunkStore';
import type { QueueItem, QueueStore } from './types';

/**
 * Durable upload-queue metadata (M5): one JSON file in the app sandbox, next to the chunk folders, so queued
 * recordings survive a restart. No audio and no tokens: ids, sizes, hashes, the consent attestation and retry state.
 * Writes go to a temp file first, then replace the old one, so a crash mid-write keeps the last good queue.
 */
export function createFileQueueStore(fs: FileSystemLike): QueueStore {
  const root = () => {
    if (!fs.documentDirectory) throw new Error('No app sandbox directory.');
    return `${fs.documentDirectory}recordings/`;
  };
  const file = () => `${root()}queue.json`;
  const tmp = () => `${root()}queue.json.tmp`;
  return {
    async load() {
      for (const uri of [file(), tmp()]) {
        if (!(await fs.getInfoAsync(uri)).exists) continue;
        try {
          const parsed: unknown = JSON.parse(await fs.readAsStringAsync(uri, { encoding: 'utf8' }));
          if (Array.isArray(parsed)) return parsed as QueueItem[];
        } catch {
          // Corrupt file: fall through to the temp copy, then to an empty queue (orphans are reconciled).
        }
      }
      return [];
    },
    async save(items) {
      await fs.makeDirectoryAsync(root(), { intermediates: true });
      await fs.writeAsStringAsync(tmp(), JSON.stringify(items), { encoding: 'utf8' });
      await fs.writeAsStringAsync(file(), JSON.stringify(items), { encoding: 'utf8' });
      await fs.deleteAsync(tmp(), { idempotent: true });
    },
  };
}
