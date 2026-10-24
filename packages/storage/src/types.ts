import type { Readable } from 'node:stream';
import type { PresignedUrl } from '@meetops/contracts/legacy';
import type { MeetingObjectRef } from './keys.js';

/** Provider registry ids. contracts' FileObject.provider is a plain string; keep the union here until contracts owns it. */
export type StorageProviderId = 'minio' | 'r2' | 's3';

/** Object info, field names aligned with contracts FileObject. No bucket/provider exposed. */
export type StoredObjectInfo = {
  sizeBytes: number;
  mimeType?: string;
  etag?: string;
  /** Lowercase 64-char hex sha256 (DB/contracts form). Absent for multipart objects (S3 only has a composite). */
  checksumSha256?: string;
  updatedAt?: Date;
  metadata?: Record<string, string>;
};

export type UploadSpec = {
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string;
  metadata?: Record<string, string>;
};

export type PresignOptions = { ttlSeconds?: number };

/** Client presign spec: checksumSha256 (standard base64 sha256 of the whole object) is REQUIRED. */
export type PresignUploadSpec = UploadSpec & { checksumSha256: string };

/**
 * A single-use presigned upload. `uploadToken` is SERVER-ONLY: persist it with the pending file and pass it to
 * confirmUpload / completeMultipartUpload. It is also signed into the request as `x-amz-meta-upload-token`
 * (in `headers`/`fields`), so it is visible to the uploader; it is not a secret, only a one-time nonce.
 */
export type PresignedUpload = PresignedUrl & { uploadToken: string };

export type PutObjectBody = Buffer | Uint8Array | string | Readable;

export type GetObjectResult = { body: Readable; info: StoredObjectInfo };

export type MultipartSpec = PresignUploadSpec & { partSizeBytes: number };
export type MultipartUpload = { uploadId: string; partCount: number; partSizeBytes: number; uploadToken: string };
/** checksumSha256 = base64 sha256 of that part (required when completing; ListParts reports it). */
export type CompletedPart = { partNumber: number; etag: string; checksumSha256?: string };

/**
 * Result of a successful server-side upload verification. Native Apps contract: the device may delete its local
 * copy ONLY when it receives `verified: true`. Any error (or no response) means "keep the local copy and retry".
 */
export type UploadVerification = {
  verified: true;
  /** Lowercase 64-char hex sha256 of the stored object (as verified by the server). */
  sha256: string;
  /** Same value as `sha256`: lowercase hex, matching FileObject.checksumSha256 (DB). */
  checksumSha256: string;
  /** The same digest in S3 x-amz-checksum-sha256 form (standard padded base64). */
  checksumSha256Base64: string;
  sizeBytes: number;
};

/** A key read from storage of record (file_objects.key or a cached key); validated, never rebuilt. */
export type StoredKeyRef = { organizationId: string; meetingId: string; key: string };

export interface StorageService {
  /** Stored-key reads: accept organizations/ and legacy org/ keys owned by organizationId+meetingId. */
  getObjectByKey(s: StoredKeyRef): Promise<GetObjectResult>;
  headObjectByKey(s: StoredKeyRef): Promise<StoredObjectInfo | null>;
  getPresignedDownloadUrlByKey(s: StoredKeyRef, opts?: PresignOptions): Promise<PresignedUrl>;
  putObject(ref: MeetingObjectRef, body: PutObjectBody, spec: UploadSpec): Promise<{ etag?: string }>;
  getObject(ref: MeetingObjectRef): Promise<GetObjectResult>;
  headObject(ref: MeetingObjectRef): Promise<StoredObjectInfo | null>;
  deleteObject(ref: MeetingObjectRef): Promise<void>;
  /** Preferred upload path: presigned POST with content-length-range and exact Content-Type. */
  getPresignedUploadPost(ref: MeetingObjectRef, spec: PresignUploadSpec, opts?: PresignOptions): Promise<PresignedUpload>;
  /** Presigned PUT with signed Content-Type and Content-Length (for providers without POST, e.g. R2). */
  getPresignedUploadUrl(ref: MeetingObjectRef, spec: PresignUploadSpec, opts?: PresignOptions): Promise<PresignedUpload>;
  /** Consume the one-time token of a finished single-part upload and verify the stored object. Rejects reuse. */
  confirmUpload(ref: MeetingObjectRef, uploadToken: string): Promise<StoredObjectInfo>;
  getPresignedDownloadUrl(ref: MeetingObjectRef, opts?: PresignOptions): Promise<PresignedUrl>;
  createMultipartUpload(ref: MeetingObjectRef, spec: MultipartSpec): Promise<MultipartUpload>;
  getPresignedPartUrl(
    ref: MeetingObjectRef,
    uploadId: string,
    partNumber: number,
    partSizeBytes: number,
    partChecksumSha256: string,
    opts?: PresignOptions
  ): Promise<PresignedUrl>;
  listParts(ref: MeetingObjectRef, uploadId: string): Promise<CompletedPart[]>;
  completeMultipartUpload(ref: MeetingObjectRef, uploadId: string, parts: CompletedPart[], uploadToken: string): Promise<{ etag?: string }>;
  abortMultipartUpload(ref: MeetingObjectRef, uploadId: string): Promise<void>;
  /** Idempotent, retry-safe verify-on-complete for a single-part upload. */
  verifyUpload(ref: MeetingObjectRef, uploadToken: string): Promise<UploadVerification>;
  /** Idempotent, retry-safe complete + streamed whole-object sha256 verify for a multipart upload. */
  verifyMultipartUpload(ref: MeetingObjectRef, uploadId: string, parts: CompletedPart[], uploadToken: string): Promise<UploadVerification>;
}

export type { PresignedUrl } from '@meetops/contracts/legacy';
