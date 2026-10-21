/**
 * Thin local mirrors of shared types from @meetops/contracts.
 *
 * TODO(contracts): replace with `import type { RecordingStatus } from '@meetops/contracts'`
 * (and add "@meetops/contracts": "workspace:*") once PR #17 (feat/core-contracts) is merged
 * into main. Must stay identical to packages/contracts/src/domain/media.ts on that branch.
 *
 * Note: this is the server-side lifecycle of an uploaded recording, not the local capture
 * state of the extension (see CaptureStatus in messages.ts).
 */
export type RecordingStatus = 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';
