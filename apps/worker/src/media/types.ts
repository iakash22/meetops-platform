import type { MediaJobPayload, TranscriptionJobPayload } from '@meetops/contracts';

/** Contracts v0.2 (#38 @ a9d9d89) own the media job payload, queue and job name. */
export { MEDIA_QUEUE, MEDIA_JOB_NAME, MediaJobPayload as MediaJobPayloadSchema } from '@meetops/contracts';
export type { MediaJobPayload, TranscriptionJobPayload };

export type ChunkManifestEntry = {
  index: number;
  fileObjectId: string;
  startMs: number;
  durationMs: number;
  sizeBytes: number;
  transcriptionJobId: string;
};

export type MediaProcessingResult = {
  recordingId: string;
  durationMs: number;
  formatName: string;
  normalized: { fileObjectId: string; sizeBytes: number };
  chunks: ChunkManifestEntry[];
  /** Present when the waveform step succeeded (stored at processed/{recordingId}/waveform.json). */
  waveform?: { bins: number; sizeBytes: number };
};

/** Mirrors apps/realtime/src/events.ts (MEDIA_EVENTS). Ids and codes only: never keys, URLs or paths. */
export type UploadStatusEvent = {
  organizationId: string;
  meetingId: string;
  uploadId: string;
  status: 'pending' | 'uploaded' | 'verified' | 'failed' | 'expired';
  sha256?: string;
  sizeBytes?: number;
  errorCode?: string;
  at: string;
};

export type ProcessingStatusEvent = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  status: 'queued' | 'normalizing' | 'waveform' | 'chunking' | 'completed' | 'failed';
  percent?: number;
  errorCode?: string;
  at: string;
};
