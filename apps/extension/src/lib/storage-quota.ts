import { LOCAL_RECORDING_CHUNK_BYTES } from './contract-limits.js';

/**
 * Origin-wide storage quota (navigator.storage.estimate) for the extension's IndexedDB recording queue.
 * The ChunkStore cap only bounds our own bytes; the browser quota can run out first (low disk), and then
 * IndexedDB writes fail. Start checks this so the user is warned before audio is lost, never after.
 */
export interface QuotaEstimate {
  usage: number;
  quota: number;
}

export type QuotaLevel = 'ok' | 'low' | 'full';

/** Warn once this share of the browser quota is used. */
export const QUOTA_LOW_RATIO = 0.9;

export const QUOTA_LOW_MESSAGE =
  'Browser storage for MeetOps AI is almost full. Recordings stay on this device until they upload; free disk ' +
  'space or upload/discard pending recordings so new audio is not refused.';
export const QUOTA_FULL_START_MESSAGE =
  'Browser storage for MeetOps AI is full, so recording was not started. Free disk space or upload/discard ' +
  'pending recordings, then try again.';
export const QUOTA_CHECK_FAILED_MESSAGE =
  'Could not check browser storage space, so recording was not started. Try again.';

/**
 * 'full' when less than one local recording chunk is free; 'low' above QUOTA_LOW_RATIO.
 * Throws on an unknown quota (non-finite or non-positive) so callers fail closed instead of reporting 'ok'.
 */
export function quotaLevel(
  e: QuotaEstimate,
  reserveBytes: number = LOCAL_RECORDING_CHUNK_BYTES,
): QuotaLevel {
  const { usage, quota } = e;
  if (!isKnownQuota(usage, quota)) throw new Error('storage quota is unknown');
  if (quota - usage < reserveBytes) return 'full';
  return usage >= quota * QUOTA_LOW_RATIO ? 'low' : 'ok';
}

export interface StorageManagerLike {
  estimate(): Promise<{ usage?: number; quota?: number }>;
  persist?(): Promise<boolean>;
}

const defaultManager = (): StorageManagerLike | undefined =>
  typeof navigator !== 'undefined'
    ? (navigator.storage)
    : undefined;

/** Current usage/quota. Throws when the browser cannot report it (callers fail closed). */
export async function estimateQuota(
  sm: StorageManagerLike | undefined = defaultManager(),
): Promise<QuotaEstimate> {
  if (!sm) throw new Error('navigator.storage is unavailable');
  const r = await sm.estimate();
  // Fail closed: a missing or nonsensical estimate is "unknown", never "0 used of 0" (which reads as ok).
  if (!isKnownQuota(r.usage, r.quota)) throw new Error('navigator.storage.estimate() did not report a quota');
  return { usage: r.usage, quota: r.quota };
}

function isKnownQuota(usage: unknown, quota: unknown): boolean {
  return (
    typeof usage === 'number' &&
    typeof quota === 'number' &&
    Number.isFinite(usage) &&
    Number.isFinite(quota) &&
    usage >= 0 &&
    quota > 0
  );
}

/**
 * Ask the browser to mark our storage persistent so it is not evicted under storage pressure.
 * Best effort: false when unsupported or refused.
 */
export async function requestPersistentStorage(
  sm: StorageManagerLike | undefined = defaultManager(),
): Promise<boolean> {
  try {
    return (await sm?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
