import { createHash } from 'node:crypto';

/** Deterministic ids so retries overwrite the same objects and never duplicate jobs. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertId(name: string, v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${name}`);
  return v;
}

/** Fixed namespace for deterministic (RFC 4122 v5) media FileObject ids. */
export const MEDIA_UUID_NAMESPACE = '6f0d3a4e-1c2b-5d7e-9f80-a1b2c3d4e5f6';

/** RFC 4122 version-5 UUID (SHA-1, namespace + name). Contracts v0.2 requires Id to be a uuid. */
export function uuidV5(name: string, namespace = MEDIA_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const normalizedFileObjectId = (recordingId: string) => uuidV5(`normalized:${recordingId}`);
export const chunkFileObjectId = (recordingId: string, index: number) => uuidV5(`chunk:${recordingId}:${index}`);

/** BullMQ custom ids must not contain ':'; use '_' separators. */
export const mediaJobId = (organizationId: string, recordingId: string) => `media_${organizationId}_${recordingId}`;
export const transcriptionJobId = (organizationId: string, recordingId: string, index: number) =>
  `transcribe_${organizationId}_${recordingId}_${String(index).padStart(5, '0')}`;
export const transcriptionIdempotencyKey = (recordingId: string, index: number) => `transcribe:${recordingId}:${index}`;

/**
 * Inverse of transcriptionIdempotencyKey. TranscriptionJobPayload has no chunk index field, so the
 * STT worker derives the chunk storage ref {kind:'chunk', objectId: recordingId, index} from this.
 */
export function parseTranscriptionIdempotencyKey(key: string): { recordingId: string; index: number } | null {
  const m = /^transcribe:([A-Za-z0-9_-]+):(\d{1,5})$/.exec(key);
  return m ? { recordingId: m[1]!, index: Number(m[2]) } : null;
}
