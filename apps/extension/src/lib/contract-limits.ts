/**
 * Mirrors of @meetops/contracts recording limits that are not (yet) in the light `@meetops/contracts/types` entry.
 * Importing them from the main entry would pull TypeBox into the bundle. test/contract-limits.test.ts asserts they
 * equal the contracts values. TODO(arch): move these to packages/contracts/src/constants.ts and import from /types.
 */
export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_CHUNKS = 10_000;
export const MAX_CHUNKS = MAX_RECORDING_CHUNKS;
/**
 * Longest recording `durationMs` accepted by CompleteRecordingSessionRequest (4 h, contracts v0.4.1 G9). Re-exported
 * from the light `/types` entry (no TypeBox) so the extension can never drift from the server limit.
 */
export { MAX_DURATION_MS } from '@meetops/contracts/types';
