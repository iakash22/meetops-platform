import { createApiClient } from '../api/client';
import { fillPath, RECORDING_SESSION_ROUTES as R } from '../api/paths';
import type { RecordingUploadApi } from './types';

export interface HttpRecordingUploadApiOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/**
 * Recording-session routes over HTTP (Bearer). BACKEND DEPENDENCY: `feat/api-recording-sessions` (no PR yet) and
 * Bearer acceptance for the mobile audience. Presigned PUTs go straight to storage: https only, signed headers sent
 * verbatim, no Authorization header and no cookies.
 */
export function createHttpRecordingUploadApi({
  baseUrl,
  getAccessToken,
  fetchImpl,
}: HttpRecordingUploadApiOptions): RecordingUploadApi {
  const { request } = createApiClient({ baseUrl, getAccessToken, fetchImpl });
  const doFetch = fetchImpl ?? fetch;
  return {
    init: (organizationId, body) =>
      request('POST', fillPath(R.init, { organizationId }), body, 201),
    chunkUrl: (sessionId, body) => request('POST', fillPath(R.chunks, { sessionId }), body),
    complete: (sessionId, body) => request('POST', fillPath(R.complete, { sessionId }), body),
    abort: (sessionId, reason) =>
      request('POST', fillPath(R.abort, { sessionId }), { reason }, 204),
    async put(upload, body) {
      if (!upload.url.startsWith('https://')) throw new Error('Refusing a non-TLS upload URL.');
      const headers = { ...upload.headers } as Record<string, string>;
      // `content-length` is set by the platform from the body; it is signed, so sizes must match.
      delete headers['content-length'];
      const res = await doFetch(upload.url, {
        method: 'PUT',
        headers,
        body: body as unknown as BodyInit,
        credentials: 'omit',
      });
      if (res.status < 200 || res.status >= 300)
        throw new Error(`Chunk upload failed (${res.status}).`);
    },
  };
}
