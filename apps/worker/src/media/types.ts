import type { TranscriptionJobPayload, SttProviderId } from '@meetops/contracts';

export const MEDIA_QUEUE_NAME = 'media';
export const MEDIA_JOB_NAME = 'process_recording';

/**
 * Media-processing job input. Local type: contracts (PR #17 @ 1531a13) has no media job yet.
 * The recording must already be in storage at the key derived from
 * {organizationId, meetingId, recordingId, sourceExt}.
 */
export type MediaProcessingJobPayload = {
  jobVersion: 1;
  kind: 'process_recording';
  organizationId: string;
  meetingId: string;
  recordingId: string;
  /** Extension of the uploaded recording (e.g. "webm"). */
  sourceExt: string;
  /** Optional: if the producer has the stored key, it is verified against org + derived key. */
  sourceKey?: string;
  sttProviderId?: SttProviderId;
  languageHint?: string;
  requestId?: string;
};

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
};

export type { TranscriptionJobPayload };
