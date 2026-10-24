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
  /** Present when the waveform step succeeded (processed/{recordingId}/waveform.json). Derived and untracked: no FileObject row. */
  waveform?: { bins: number; sizeBytes: number };
};
