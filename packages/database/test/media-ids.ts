/**
 * Copy of the worker's id scheme (PR #39, apps/worker/src/media/ids.ts) so the database tests prove
 * file_objects accepts exactly the ids the worker supplies. Keep in sync with that file.
 */
import { createHash } from 'node:crypto';

export const MEDIA_UUID_NAMESPACE = '6f0d3a4e-1c2b-5d7e-9f80-a1b2c3d4e5f6';

export function uuidV5(name: string, namespace = MEDIA_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const normalizedFileObjectId = (recordingId: string): string =>
  uuidV5(`normalized:${recordingId}`);
export const chunkFileObjectId = (recordingId: string, index: number): string =>
  uuidV5(`chunk:${recordingId}:${index}`);
