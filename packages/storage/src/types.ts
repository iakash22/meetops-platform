import type { Readable } from 'node:stream';
import type { PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';

export type StorageProviderId = 'minio' | 'r2' | 's3';

export type PutObjectOptions = {
  contentType?: string;
  /** Declared size in bytes; validated by the size hook when provided. */
  contentLength?: number;
  checksumSha256?: string;
  metadata?: Record<string, string>;
  expiresInSeconds?: number;
};

export type PutObjectBody = Buffer | Uint8Array | string | Readable;

export type GetObjectResult = {
  body: Readable;
  metadata: StorageObjectMetadata;
};

export type MultipartUpload = { key: string; uploadId: string };
export type CompletedPart = { partNumber: number; etag: string };

export interface StorageService {
  readonly providerId: StorageProviderId;
  readonly bucket: string;
  putObject(key: string, body: PutObjectBody, options?: PutObjectOptions): Promise<{ etag?: string }>;
  getObject(key: string): Promise<GetObjectResult>;
  getPresignedUploadUrl(key: string, options?: PutObjectOptions): Promise<PresignedUrl>;
  getPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<PresignedUrl>;
  headObject(key: string): Promise<StorageObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;
  createMultipartUpload(key: string, options?: PutObjectOptions): Promise<MultipartUpload>;
  getPresignedPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds?: number): Promise<PresignedUrl>;
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  listParts(key: string, uploadId: string): Promise<CompletedPart[]>;
}

export type { PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';
