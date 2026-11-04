/**
 * Mirrors of @meetops/contracts recording limits that are not (yet) in the light `@meetops/contracts/types` entry.
 * Importing them from the main entry would pull TypeBox into the bundle. test/contract-limits.test.ts asserts they
 * equal the contracts values. TODO(arch): move these to packages/contracts/src/constants.ts and import from /types.
 */
export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
import { MAX_CHUNK_BYTES } from '@meetops/contracts/types';

/**
 * Server limit for ONE chunk PUT, read straight from @meetops/contracts (MAX_CHUNK_BYTES, 64 MiB; the light
 * `/types` entry re-exports constants.ts without TypeBox). storage's chunk-URL check enforces exactly this value.
 */
export const UPLOAD_CHUNK_MAX_BYTES = MAX_CHUNK_BYTES;

export const MAX_RECORDING_CHUNKS = 10_000;
/**
 * Local recording chunk size: the largest chunk the extension writes to IndexedDB and later uploads. Aligned to the
 * server limit (one value, no 8 MiB vs 64 MiB mismatch): the recorder splits oversized timeslices at it, and Start
 * requires one full chunk of free room (drain.ts MIN_FREE_FOR_RECORDING_BYTES, storage-quota.ts) so the first chunk
 * of a new recording is never refused. Normal 10 s opus slices are tens of KiB, far below it.
 */
export const LOCAL_RECORDING_CHUNK_BYTES = UPLOAD_CHUNK_MAX_BYTES;
export const MAX_CHUNKS = MAX_RECORDING_CHUNKS;
/**
 * Longest recording `durationMs` accepted by CompleteRecordingSessionRequest (4 h, contracts v0.4.1 G9). Re-exported
 * from the light `/types` entry (no TypeBox) so the extension can never drift from the server limit.
 */
export { MAX_DURATION_MS } from '@meetops/contracts/types';
