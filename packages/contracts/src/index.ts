export * from './formats.js';
export * from './common.js';
export * from './domain/index.js';
export * from './api/index.js';
export * from './jobs/index.js';
/**
 * Phase 0 email types. The legacy storage types (PresignedUrl, StorageObjectMetadata) are no longer
 * exported here; import them from '@meetops/contracts/legacy' (deprecated).
 */
export type { EmailAddress, EmailMessage } from './legacy.js';
export * from './realtime/index.js';
/**
 * @deprecated Transitional re-export so @meetops/storage keeps compiling during migration.
 * Import from '@meetops/contracts/legacy' instead. Removed from the main barrel in 0.3.0.
 */
export type { PresignedUrl, StorageObjectMetadata } from './legacy.js';
