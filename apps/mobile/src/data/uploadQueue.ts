/**
 * Offline upload queue as seen by the Record tab. Placeholder only: the real queue (durable
 * on-device storage, chunked resumable upload, checksums) arrives with native recording and the
 * Media upload contract. Nothing is ever queued by the M2 shell.
 */
export interface UploadQueueStatus {
  /** Recordings stored on the device that still need to upload. */
  pending: number;
  /** Whether uploads are currently paused because the device is offline. */
  offline: boolean;
}

export interface UploadQueue {
  status: () => Promise<UploadQueueStatus>;
}

export function createPlaceholderUploadQueue(): UploadQueue {
  return {
    status: () => Promise.resolve({ pending: 0, offline: false }),
  };
}
