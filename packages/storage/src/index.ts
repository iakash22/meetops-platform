import type { PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';

export type StorageProviderId = 'minio' | 'r2' | 's3';

export type PutObjectOptions = {
  contentType?: string;
  checksumSha256?: string;
  metadata?: Record<string, string>;
};

export interface StorageService {
  readonly providerId: StorageProviderId;
  getPresignedUploadUrl(key: string, options?: PutObjectOptions): Promise<PresignedUrl>;
  getPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<PresignedUrl>;
  headObject(key: string): Promise<StorageObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;
}

export type { PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';
