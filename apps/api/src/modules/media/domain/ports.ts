import type {
  AssembleRecordingSessionJobPayload,
  MediaSourceExt,
  UploadScanJobPayload,
} from '@meetops/contracts';
import { ALLOWED_MEDIA_MIME_TYPES } from '@meetops/contracts';
import type { FileObjectScanStatus } from '@meetops/contracts';
import { DomainError } from '../../../shared/domain-error.js';

export type FileObjectStatus = 'pending_upload' | 'uploaded' | 'processing';

/** The slice of a FileObject row (file_objects) the upload routes need. */
export interface FileObjectRecord {
  id: string;
  organizationId: string;
  meetingId: string | null;
  uploadedById: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256Base64: string;
  originalName: string;
  status: FileObjectStatus;
  /** null until complete; complete sets `pending`; the scanner moves it to clean/quarantined/rejected. */
  scanStatus: FileObjectScanStatus | null;
  createdAt: Date;
}

export interface FileObjectRepository {
  create(r: FileObjectRecord): Promise<FileObjectRecord>;
  findById(organizationId: string, id: string): Promise<FileObjectRecord | null>;
  setStatus(
    organizationId: string,
    id: string,
    status: FileObjectStatus,
    scanStatus?: FileObjectScanStatus,
  ): Promise<void>;
}

export interface StoredObjectHead {
  sizeBytes: number;
  checksumSha256Base64: string | null;
}

/** Presigned request returned by the signer (expiresAt is a Date; routes serialise it). */
export interface SignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Storage signer port. Production adapter: @meetops/storage S3StorageService (not yet a dependency of apps/api,
 * see the media module README note). Signs Content-Length and x-amz-checksum-sha256 into every PUT.
 */
export interface MediaSigner {
  presignPut(spec: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    ttlSeconds: number;
  }): Promise<SignedRequest>;
  /**
   * Presigned download. Adapters MUST force `response-content-disposition=attachment` and
   * `response-content-type=<downloadContentType(contentType)>` (allowlisted base type, else application/octet-stream)
   * so an untrusted upload is never rendered inline (security review B 4.1). @meetops/storage does this.
   */
  presignGet(spec: {
    key: string;
    ttlSeconds: number;
    contentType: string;
  }): Promise<SignedRequest>;
  /**
   * Stored object size and full-object SHA-256 (base64), or null when nothing was uploaded at `key`. Adapters must
   * HEAD with checksum mode enabled (S3/MinIO `ChecksumMode: 'ENABLED'` -> `ChecksumSHA256`) and return
   * `checksumSha256Base64: null` when the store reports none; complete() then rejects the upload.
   */
  head(key: string): Promise<StoredObjectHead | null>;
}

/**
 * Media pipeline job (contracts, ADR-014). Uploads enqueue `process_upload`; completed recording sessions enqueue
 * `assemble_recording_session` (the worker concatenates the chunks and then enqueues `process_recording`).
 */
export type MediaProcessingJob = UploadScanJobPayload | AssembleRecordingSessionJobPayload;

export interface MediaJobQueue {
  /** Idempotent per job: adapters derive a deterministic job id from kind + subject id. */
  enqueue(job: MediaProcessingJob): Promise<void>;
}

/** Deterministic BullMQ job id: a retried complete/scan call never queues a second job. */
export function mediaJobId(job: MediaProcessingJob): string {
  return job.kind === 'process_upload'
    ? `process_upload:${job.uploadId}`
    : `assemble_recording_session:${job.sessionId}`;
}

const SESSION_EXT: Record<string, MediaSourceExt> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** Source container for a recording session from its MIME type (parameters such as `;codecs=` are ignored). */
export function sessionSourceExt(mimeType: string): MediaSourceExt | null {
  return SESSION_EXT[mimeType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

/**
 * Storage key of a session chunk. Byte-identical to @meetops/storage buildObjectKey({kind:'session_chunk'}):
 * tmp/session-chunks/organizations/{org}/meetings/{meeting}/sessions/{session}/{seq:5}.part, so the worker's
 * StorageService (assertKeyOwnedBy) accepts it and the tmp/ lifecycle rule expires abandoned chunks.
 */
export function sessionChunkKey(
  organizationId: string,
  meetingId: string,
  sessionId: string,
  seq: number,
): string {
  return `tmp/session-chunks/organizations/${organizationId}/meetings/${meetingId}/sessions/${sessionId}/${String(seq).padStart(5, '0')}.part`;
}

export class UploadNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Upload not found', 404);
  }
}

export class UploadStateConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

/** Allowlisted base media type for downloads (`;codecs=` stripped), else application/octet-stream. */
export function downloadContentType(contentType: string): string {
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return (ALLOWED_MEDIA_MIME_TYPES as readonly string[]).includes(base)
    ? base
    : 'application/octet-stream';
}
