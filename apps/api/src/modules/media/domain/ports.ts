import type { ConsentSubjectType, FileObjectScanStatus } from '@meetops/contracts';
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
  presignGet(spec: { key: string; ttlSeconds: number }): Promise<SignedRequest>;
  /**
   * Stored object size and full-object SHA-256 (base64), or null when nothing was uploaded at `key`. Adapters must
   * HEAD with checksum mode enabled (S3/MinIO `ChecksumMode: 'ENABLED'` -> `ChecksumSHA256`) and return
   * `checksumSha256Base64: null` when the store reports none; complete() then rejects the upload.
   */
  head(key: string): Promise<StoredObjectHead | null>;
}

/** Processing job. Local shape: contracts MediaJobPayload needs meetingId + recordingId, which uploads may lack. */
export interface MediaProcessingJob {
  kind: 'process_upload' | 'process_recording_session';
  organizationId: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  consentAttestationId: string;
  meetingId?: string;
}

export interface MediaJobQueue {
  enqueue(job: MediaProcessingJob): Promise<void>;
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
