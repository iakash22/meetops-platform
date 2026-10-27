import type { RecordingUploadApi } from './upload-queue';

/**
 * Typed stand-in used until the Rust `api_request` / `upload_put` commands land (Cargo.lock slot).
 * Shapes follow `@meetops/contracts` recording-session routes; nothing leaves the machine.
 */
export function createSimulatedUploadApi(delayMs = 300): RecordingUploadApi {
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  return {
    async init() {
      await wait();
      return { sessionId: crypto.randomUUID() };
    },
    async chunkUrl(sessionId, body) {
      await wait();
      return {
        upload: {
          method: 'PUT',
          url: `https://uploads.invalid/${sessionId}/${body.seq}`,
          headers: { 'content-length': String(body.sizeBytes) },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        seq: body.seq,
      };
    },
    put: wait,
    complete: wait,
    abort: wait,
  };
}
