import type { ApiErrorCode } from '@meetops/contracts';

import { AuthError } from '@/features/auth/auth-client';
import { fillPath, RECORDING_SESSION_ROUTES as R } from '@/lib/api-paths';
import type { RecordingUploadApi } from './upload-queue';

/** Same shape as `@tauri-apps/api/core` `invoke`. */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Recording-session routes through Rust (ADR-012 3.3: the webview CSP has no API or storage origin, and the bearer
 * never leaves Rust). `upload_put` streams bytes to the presigned URL with the signed headers verbatim.
 * RUST DEPENDENCY: `api_request` and `upload_put` commands (with the ADR-012 auth module).
 */
/** Rust serializes errors as `{ code, message }`; anything else is an opaque failure. */
function toError(e: unknown): Error {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message } = e as { code: ApiErrorCode; message: string };
    return new AuthError(code, String(message));
  }
  return new Error('Upload failed.');
}

export function createNativeUploadApi(invoke: Invoke): RecordingUploadApi {
  const post = <T>(path: string, body: unknown) =>
    invoke<T>('api_request', { method: 'POST', path, body }).catch((e: unknown) => {
      throw toError(e);
    });
  return {
    init: (org, body) => post(fillPath(R.init, { organizationId: org }), body),
    chunkUrl: (sid, body) => post(fillPath(R.chunks, { sessionId: sid }), body),
    complete: (sid, body) => post(fillPath(R.complete, { sessionId: sid }), body),
    abort: async (sid, reason) => {
      await post(fillPath(R.abort, { sessionId: sid }), { reason });
    },
    put: async (upload, body) => {
      if (!upload.url.startsWith('https://')) throw new Error('Refusing a non-TLS upload URL.');
      await invoke('upload_put', { upload, body: Array.from(body) }).catch((e: unknown) => {
        throw toError(e);
      });
    },
  };
}
