import type { QueueStore, RecordingUploadApi } from './types';

/**
 * Typed stand-in for the recording-session routes while the recorder is simulated. Nothing leaves the
 * device; shapes follow `@meetops/contracts`. Swap for `createHttpRecordingUploadApi` with the M4 recorder.
 */
export function createSimulatedUploadApi(latencyMs = 300): RecordingUploadApi {
  const wait = () => new Promise<void>((r) => setTimeout(r, latencyMs));
  let n = 0;
  return {
    async init() {
      await wait();
      n += 1;
      return { sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` };
    },
    async chunkUrl(sessionId, body) {
      await wait();
      return {
        seq: body.seq,
        upload: {
          method: 'PUT',
          url: `https://uploads.invalid/${sessionId}/${body.seq}`,
          headers: { 'content-length': String(body.sizeBytes) },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      };
    },
    put: () => wait(),
    async complete() {
      await wait();
      return { status: 'uploaded' };
    },
    abort: () => wait(),
  };
}

export function createMemoryQueueStore(): QueueStore {
  let saved: string = '[]';
  return {
    load: () => Promise.resolve(JSON.parse(saved) as Awaited<ReturnType<QueueStore['load']>>),
    save: (items) => {
      saved = JSON.stringify(items);
      return Promise.resolve();
    },
  };
}
