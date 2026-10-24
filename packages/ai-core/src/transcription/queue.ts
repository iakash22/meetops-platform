import type { MediaJobPayload, TranscriptionJobPayload } from '../contracts.js';
import type { ChunkJobResult, TranscriptionChunkHandler, TranscriptionChunkJobPayload } from './handler.js';

/**
 * Consumer for Media's transcription queue (PR #39). For each `MediaJobPayload` (process_recording) Media enqueues ONE
 * contracts `TranscriptionJobPayload` per 16 kHz mono WAV chunk at `processed/{rec}/chunks/NNNNN.wav`, with:
 *   - BullMQ job id      `transcribe_{org}_{rec}_{NNNNN}`
 *   - chunkIndex/startMs contracts v0.2 fields (PR #38)
 *   - idempotencyKey     `transcribe:{rec}:{index}` (checked for consistency only)
 *   - fileObjectId       the chunk's own object id
 */

/** Mirrors Media's `transcriptionIdempotencyKey` (PR #39). */
export const transcriptionIdempotencyKey = (recordingId: string, index: number) => `transcribe:${recordingId}:${index}`;

/** Mirrors Media's `transcriptionJobId` (PR #39). */
export const transcriptionJobId = (organizationId: MediaJobPayload['organizationId'], recordingId: MediaJobPayload['recordingId'], index: number) =>
  `transcribe_${organizationId}_${recordingId}_${String(index).padStart(5, '0')}`;

/** Inverse of `transcriptionIdempotencyKey`; identical grammar to Media's (PR #39). Used only as a consistency check. */
export function parseTranscriptionIdempotencyKey(key: string): { recordingId: string; index: number } | null {
  const m = /^transcribe:([A-Za-z0-9_-]+):(\d{1,5})$/.exec(key);
  return m ? { recordingId: m[1]!, index: Number(m[2]) } : null;
}

/** Payload as it arrives from the queue (contracts v0.2). */
export type MediaTranscriptionJob = TranscriptionJobPayload;

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
  const index = data.chunkIndex;
  if (index === undefined) throw new InvalidTranscriptionJobError('missing chunkIndex (whole-file jobs are not chunk jobs)');
  // Consistency check: Media's key is `transcribe:{rec}:{index}`. Other keys are allowed but must not contradict.
  const parsed = parseTranscriptionIdempotencyKey(data.idempotencyKey);
  if (parsed && (parsed.recordingId !== data.recordingId || parsed.index !== index)) {
    throw new InvalidTranscriptionJobError('idempotencyKey does not match recordingId/chunkIndex');
  }
  if (jobId !== undefined && jobId !== transcriptionJobId(data.organizationId, data.recordingId, index)) {
    throw new InvalidTranscriptionJobError('job id does not match payload');
  }
  if (!(geo.segmentSeconds > 0)) throw new InvalidTranscriptionJobError('invalid segmentSeconds');
  const overlapSec = geo.overlapSec ?? 0;
  const { chunkIndex: _chunkIndex, startMs, ...base } = data;
  void _chunkIndex;
  return {
    ...base,
    chunk: {
      index,
      // Total count is not on the payload; merge reports `complete` only when the caller supplies it.
      // Media's measured offset wins; nominal geometry only if startMs is absent.
      startSec: startMs !== undefined ? startMs / 1000 : index * (geo.segmentSeconds - overlapSec),
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
