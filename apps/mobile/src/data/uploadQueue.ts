/**
 * Offline upload queue as seen by the Record tab. The engine lives in `src/upload/uploadQueueEngine.ts`; this
 * placeholder stays the default until the M4 recorder writes real chunks.
 */
export interface UploadQueueStatus {
  /** Recordings stored on the device that still need to upload. */
  pending: number;
  /** Whether uploads are currently paused because the device is offline. */
  offline: boolean;
  /** Recordings that stopped retrying and need the user (e.g. consent rejected). */
  failed?: number;
  /** Recordings within a day of the 7-day local retention cap (R4). */
  expiringSoon?: number;
}

export interface UploadQueue {
  status: () => Promise<UploadQueueStatus>;
}

export function createPlaceholderUploadQueue(): UploadQueue {
  return {
    status: () => Promise.resolve({ pending: 0, offline: false }),
  };
}
