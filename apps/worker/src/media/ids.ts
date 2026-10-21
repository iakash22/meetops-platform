/** Deterministic ids so retries overwrite the same objects and never duplicate jobs. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertId(name: string, v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${name}`);
  return v;
}

export const normalizedFileObjectId = (recordingId: string) => `${recordingId}-normalized`;
export const chunkFileObjectId = (recordingId: string, index: number) => `${recordingId}-chunk-${String(index).padStart(5, '0')}`;

/** BullMQ custom ids must not contain ':'; use '_' separators. */
export const mediaJobId = (organizationId: string, recordingId: string) => `media_${organizationId}_${recordingId}`;
export const transcriptionJobId = (organizationId: string, recordingId: string, index: number) =>
  `transcribe_${organizationId}_${recordingId}_${String(index).padStart(5, '0')}`;
export const transcriptionIdempotencyKey = (recordingId: string, index: number) => `transcribe:${recordingId}:${index}`;

/** Inverse of chunkFileObjectId, for the STT worker to derive the storage ref. */
export function parseChunkFileObjectId(id: string): { recordingId: string; index: number } | null {
  const m = /^(.+)-chunk-(\d{5})$/.exec(id);
  return m ? { recordingId: m[1]!, index: Number(m[2]) } : null;
}
