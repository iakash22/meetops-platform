import type { TranscriptionJobPayload } from '../contracts.js';
import type { ChunkJobResult, TranscriptionChunkHandler, TranscriptionChunkJobPayload } from './handler.js';

/**
 * Consumer for Media's transcription queue (PR #39, apps/worker/src/media). Media enqueues ONE contracts
 * `TranscriptionJobPayload` per 16 kHz mono WAV chunk stored at `processed/{rec}/chunks/NNNNN.wav`, with:
 *   - BullMQ job id      `transcribe_{org}_{rec}_{NNNNN}`
 *   - idempotencyKey     `transcribe:{rec}:{index}`
 *   - fileObjectId       the chunk's own object id
 * The contracts payload has no chunk index yet (Architecture adds it in PR #38). Until then the index is derived
 * from the idempotency key; once present, `chunkIndex` wins but must agree with the key.
 */

/** Mirrors Media's `transcriptionIdempotencyKey` (PR #39). */
export const transcriptionIdempotencyKey = (recordingId: string, index: number) => `transcribe:${recordingId}:${index}`;

/** Mirrors Media's `transcriptionJobId` (PR #39). */
export const transcriptionJobId = (organizationId: string, recordingId: string, index: number) =>
  `transcribe_${organizationId}_${recordingId}_${String(index).padStart(5, '0')}`;

/** Inverse of `transcriptionIdempotencyKey`; identical grammar to Media's (PR #39). */
export function parseTranscriptionIdempotencyKey(key: string): { recordingId: string; index: number } | null {
  const m = /^transcribe:([A-Za-z0-9_-]+):(\d{1,5})$/.exec(key);
  return m ? { recordingId: m[1]!, index: Number(m[2]) } : null;
}

/** Payload as it arrives from the queue; `chunkIndex` is the field expected from PR #38. */
export type MediaTranscriptionJob = TranscriptionJobPayload & { chunkIndex?: number | undefined };

export class InvalidTranscriptionJobError extends Error {
  readonly code = 'INVALID_JOB';
}

export type ChunkGeometry = {
  /** Must equal Media's MEDIA_CHUNK_SECONDS (default 600). ffmpeg `-segment_time` chunks have no overlap. */
  segmentSeconds: number;
  overlapSec?: number;
};

/** Pure mapping from a Media queue job to the handler's chunk payload. Throws InvalidTranscriptionJobError (non-retryable). */
export function toChunkJob(data: MediaTranscriptionJob, jobId: string | undefined, geo: ChunkGeometry): TranscriptionChunkJobPayload {
  const parsed = parseTranscriptionIdempotencyKey(data.idempotencyKey);
  if (!parsed) throw new InvalidTranscriptionJobError('unrecognized idempotencyKey');
  if (parsed.recordingId !== data.recordingId) throw new InvalidTranscriptionJobError('idempotencyKey/recordingId mismatch');
  const index = data.chunkIndex ?? parsed.index;
  if (!Number.isInteger(index) || index < 0 || index !== parsed.index) throw new InvalidTranscriptionJobError('chunk index mismatch');
  if (jobId !== undefined && jobId !== transcriptionJobId(data.organizationId, data.recordingId, index)) {
    throw new InvalidTranscriptionJobError('job id does not match payload');
  }
  if (!(geo.segmentSeconds > 0)) throw new InvalidTranscriptionJobError('invalid segmentSeconds');
  const overlapSec = geo.overlapSec ?? 0;
  const base: TranscriptionJobPayload & { chunkIndex?: number | undefined } = { ...data };
  delete base.chunkIndex;
  return {
    ...base,
    chunk: {
      index,
      // Total count is not on the payload; merge reports `complete` only when the caller supplies it.
      startSec: index * (geo.segmentSeconds - overlapSec),
      // Nominal; the provider's reported duration is used for usage when available (last chunk is shorter).
      durationSec: geo.segmentSeconds,
      overlapSec,
      fileObjectId: data.fileObjectId,
    },
  };
}

/** BullMQ-shaped processor: `new Worker(QUEUE_NAMES.transcription, (job) => consume(job), ...)` in apps/worker. */
export function createTranscriptionQueueConsumer(handler: Pick<TranscriptionChunkHandler, 'handle'>, geo: ChunkGeometry) {
  return async (job: { id?: string | undefined; data: MediaTranscriptionJob }): Promise<ChunkJobResult> =>
    handler.handle(toChunkJob(job.data, job.id, geo));
}
