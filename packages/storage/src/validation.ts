import { MediaMimeType } from '@meetops/contracts';
import type { StorageLimits } from './config.js';
import { StorageValidationError } from './errors.js';
import type { UploadSpec } from './types.js';

const MEDIA_MIME_RE = new RegExp(MediaMimeType.pattern as string);

/** True when `mime` matches contracts MediaMimeType (allowlisted type with optional ;codecs=). */
export function isContractMediaMimeType(mime: string): boolean {
  return mime.length <= 100 && MEDIA_MIME_RE.test(mime);
}

export function normalizeMimeType(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

const SHA256_B64 = /^[A-Za-z0-9+/]{43}=$/;

/** True for the standard (padded) base64 encoding of a 32-byte digest, as S3 `x-amz-checksum-sha256` expects. */
export function isSha256Base64(v: unknown): v is string {
  return typeof v === 'string' && SHA256_B64.test(v) && Buffer.from(v, 'base64').length === 32;
}

export function assertSha256Base64(v: unknown, name = 'checksumSha256'): string {
  if (v === undefined || v === null || v === '') throw new StorageValidationError(`${name} is required`);
  if (!isSha256Base64(v)) throw new StorageValidationError(`Invalid ${name}`);
  return v;
}

/** Validate a declared upload. mimeType and sizeBytes are mandatory. */
export function validateUploadSpec(spec: UploadSpec | undefined, limits: StorageLimits): void {
  if (!spec || typeof spec.mimeType !== 'string' || !spec.mimeType) throw new StorageValidationError('mimeType is required');
  if (!limits.allowedMimeTypes.includes(normalizeMimeType(spec.mimeType))) throw new StorageValidationError('mimeType not allowed');
  // Parameters are only accepted in the contracts MediaMimeType form (`;codecs=...`).
  if (spec.mimeType.includes(';') && !isContractMediaMimeType(spec.mimeType)) throw new StorageValidationError('mimeType not allowed');
  if (typeof spec.sizeBytes !== 'number' || !Number.isInteger(spec.sizeBytes)) throw new StorageValidationError('sizeBytes is required');
  if (spec.sizeBytes < 1 || spec.sizeBytes > limits.maxObjectBytes) throw new StorageValidationError('sizeBytes out of range');
  if (spec.checksumSha256 !== undefined) assertSha256Base64(spec.checksumSha256);
}
