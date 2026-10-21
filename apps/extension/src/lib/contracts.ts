/**
 * Local mirrors of @meetops/contracts v0.2 (PR #38, branch feat/contracts-v0.2):
 *   packages/contracts/src/api/recording-sessions.ts and src/domain/media.ts.
 *
 * TODO(contracts): replace with `import type { ... } from '@meetops/contracts'` and add
 * "@meetops/contracts": "workspace:*" once PR #38 is merged. Field names, literals and limits
 * must stay identical to that branch.
 *
 * Flow:
 *   POST /orgs/:organizationId/recording-sessions  InitRecordingSessionRequest -> InitRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/chunks      ChunkUploadUrlRequest -> ChunkUploadUrlResponse, then PUT bytes
 *   POST /recording-sessions/:sessionId/complete    CompleteRecordingSessionRequest -> CompleteRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/abort       AbortRecordingSessionRequest -> 204
 */

/** UUID (ADR-004: all entity ids are UUIDs). */
export type Id = string;
/** ISO 8601 date-time string. */
export type IsoDateTime = string;

export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
/** 64 MiB per chunk. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** 2 GB (decimal) per recording session, enforced server-side. */
export const MAX_MEDIA_BYTES = 2_000_000_000;
export const MAX_RECORDING_SESSION_BYTES = MAX_MEDIA_BYTES;
export const MAX_RECORDING_CHUNKS = 100_000;
/** Max durationMs accepted by complete (24 h). */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Server-side lifecycle of an uploaded recording (domain/media.ts). */
export type RecordingStatus = 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';

/** Capture source. */
export type RecordingSource = 'tab';

/** Allowlisted media MIME type, optionally with `;codecs=` (e.g. 'audio/webm;codecs=opus'). */
export type MediaMimeType = string;

export interface PresignedUrlDto {
  url: string;
  method: 'GET' | 'PUT' | 'POST';
  headers?: Record<string, string>;
  expiresAt: IsoDateTime;
}

export interface InitRecordingSessionRequest {
  mimeType: MediaMimeType;
  startedAt: IsoDateTime;
  source: RecordingSource;
  meetingId?: Id;
}
export interface InitRecordingSessionResponse {
  sessionId: Id;
}

export interface ChunkUploadUrlRequest {
  /** 0 .. MAX_RECORDING_CHUNKS - 1 */
  seq: number;
}
/** `upload.method` is always PUT; `upload.expiresAt` is at most CHUNK_UPLOAD_URL_TTL_SECONDS out. */
export interface ChunkUploadUrlResponse {
  seq: number;
  upload: Omit<PresignedUrlDto, 'method'> & { method: 'PUT' };
}

export interface CompleteRecordingSessionRequest {
  /** 1 .. MAX_RECORDING_CHUNKS (a session with no chunks must be aborted instead). */
  chunkCount: number;
  /** 0 .. MAX_DURATION_MS */
  durationMs: number;
}
export interface CompleteRecordingSessionResponse {
  status: RecordingStatus;
}

export type AbortReason = 'user_stopped' | 'consent_revoked' | 'tab_closed' | 'error';
export interface AbortRecordingSessionRequest {
  reason: AbortReason;
}
