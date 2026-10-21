/**
 * Upload API contract: re-exported from @meetops/contracts (v0.2, PR #38, merged in
 * integration/phase-1 at b933f76). Only extension-local additions live here.
 *
 * Flow:
 *   POST /orgs/:organizationId/recording-sessions  InitRecordingSessionRequest -> InitRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/chunks      ChunkUploadUrlRequest -> ChunkUploadUrlResponse, then PUT bytes
 *   POST /recording-sessions/:sessionId/complete    CompleteRecordingSessionRequest -> CompleteRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/abort       AbortRecordingSessionRequest -> 204
 */
export {
  CHUNK_UPLOAD_URL_TTL_SECONDS,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_MEDIA_BYTES,
  MAX_RECORDING_CHUNKS,
  MAX_RECORDING_SESSION_BYTES,
} from '@meetops/contracts';
export type {
  AbortReason,
  AbortRecordingSessionRequest,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  CompletedChunk,
  Id,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
  IsoDateTime,
  MediaMimeType,
  PresignedUrlDto,
  RecordingSource,
  RecordingStatus,
} from '@meetops/contracts';

/** Extension-local: lowercase hex SHA-256 (the contract's Sha256Hex schema is not exported). */
export type Sha256Hex = string;

/**
 * Extension-local: longest durationMs the recorder reports to complete() (24 h). Not exported by
 * @meetops/contracts; keep in sync with the API's validation.
 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
