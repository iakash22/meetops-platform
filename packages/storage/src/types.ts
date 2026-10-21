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

export type PutObjectBody = Buffer | Uint8Array | string | Readable;

export type GetObjectResult = { body: Readable; info: StoredObjectInfo };

export type MultipartSpec = UploadSpec & { partSizeBytes: number };
export type MultipartUpload = { uploadId: string; partCount: number; partSizeBytes: number };
export type CompletedPart = { partNumber: number; etag: string };

export interface StorageService {
  putObject(ref: MeetingObjectRef, body: PutObjectBody, spec: UploadSpec): Promise<{ etag?: string }>;
  getObject(ref: MeetingObjectRef): Promise<GetObjectResult>;
  headObject(ref: MeetingObjectRef): Promise<StoredObjectInfo | null>;
  deleteObject(ref: MeetingObjectRef): Promise<void>;
  /** Preferred upload path: presigned POST with content-length-range and exact Content-Type. */
  getPresignedUploadPost(ref: MeetingObjectRef, spec: UploadSpec, opts?: PresignOptions): Promise<PresignedUrl>;
  /** Presigned PUT with signed Content-Type and Content-Length (for providers without POST, e.g. R2). */
  getPresignedUploadUrl(ref: MeetingObjectRef, spec: UploadSpec, opts?: PresignOptions): Promise<PresignedUrl>;
  getPresignedDownloadUrl(ref: MeetingObjectRef, opts?: PresignOptions): Promise<PresignedUrl>;
  createMultipartUpload(ref: MeetingObjectRef, spec: MultipartSpec): Promise<MultipartUpload>;
  getPresignedPartUrl(ref: MeetingObjectRef, uploadId: string, partNumber: number, partSizeBytes: number, opts?: PresignOptions): Promise<PresignedUrl>;
  listParts(ref: MeetingObjectRef, uploadId: string): Promise<CompletedPart[]>;
  completeMultipartUpload(ref: MeetingObjectRef, uploadId: string, parts: CompletedPart[]): Promise<{ etag?: string }>;
  abortMultipartUpload(ref: MeetingObjectRef, uploadId: string): Promise<void>;
}

export type { PresignedUrl } from '@meetops/contracts/legacy';
