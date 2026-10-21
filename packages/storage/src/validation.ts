import type { StorageLimits } from './config.js';
import { StorageValidationError } from './errors.js';
import type { UploadSpec } from './types.js';

export function normalizeMimeType(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** Validate a declared upload. mimeType and sizeBytes are mandatory. */
export function validateUploadSpec(spec: UploadSpec | undefined, limits: StorageLimits): void {
  if (!spec || typeof spec.mimeType !== 'string' || !spec.mimeType) throw new StorageValidationError('mimeType is required');
  if (!limits.allowedMimeTypes.includes(normalizeMimeType(spec.mimeType))) throw new StorageValidationError('mimeType not allowed');
  if (typeof spec.sizeBytes !== 'number' || !Number.isInteger(spec.sizeBytes)) throw new StorageValidationError('sizeBytes is required');
  if (spec.sizeBytes < 1 || spec.sizeBytes > limits.maxObjectBytes) throw new StorageValidationError('sizeBytes out of range');
}
