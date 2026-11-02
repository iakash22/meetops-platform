/**
 * Mirrors of @meetops/contracts recording limits that are not (yet) in the light `@meetops/contracts/types` entry.
 * Importing them from the main entry would pull TypeBox into the bundle. test/contract-limits.test.ts asserts they
 * equal the contracts values. TODO(arch): move these to packages/contracts/src/constants.ts and import from /types.
 */
export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_CHUNKS = 10_000;
/**
 * Largest chunk the extension writes to local storage (and uploads): 8 MiB, one shared value for the recorder's
 * split size and the free-space reserve Start requires (drain.ts MIN_FREE_FOR_RECORDING_BYTES).
 *
 * Why 8 MiB and not the server ceiling MAX_CHUNK_BYTES (64 MiB): the local IndexedDB cap is 500 MiB and held
 * recordings are never evicted, so the Start reserve has to stay small; a reserve smaller than one chunk (the old
 * 8 MiB reserve vs 64 MiB chunks) let Start pass and then refuse the very first chunk. 10 s opus slices are tens of
 * KiB, so 8 MiB only matters for throttled/oversized timeslices, and it stays well under the 64 MiB server limit.
 */
export const LOCAL_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNKS = MAX_RECORDING_CHUNKS;
/**
 * Longest recording `durationMs` accepted by CompleteRecordingSessionRequest (4 h, contracts v0.4.1 G9). Re-exported
 * from the light `/types` entry (no TypeBox) so the extension can never drift from the server limit.
 */
export { MAX_DURATION_MS } from '@meetops/contracts/types';
