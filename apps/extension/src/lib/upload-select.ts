/** Choosing and assembling the upload client for the WXT_FEATURE_HTTP_UPLOAD flag. */
import { NotPairedError } from './auth/auth-service.js';
import type { AuthStatus } from './auth/messages.js';
import { storageWithRetry, verifyingStorage } from './upload-http.js';
import type { RetryPolicy } from './retry.js';
import {
  StubUploadClient,
  createFetchTransport,
  type StorageTransport,
  type UploadClient,
} from './upload.js';

/** StubUploadClient unless the flag is on; the real client is only constructed when it is used. */
export function selectUploadClient(
  httpUpload: boolean,
  makeHttp: () => UploadClient,
): UploadClient {
  return httpUpload ? makeHttp() : new StubUploadClient();
}

/** The paired token's organization (recording sessions are created under it), or NotPairedError. */
export function pairedOrganizationId(auth: {
  status(): Promise<AuthStatus>;
}): () => Promise<string> {
  return async () => {
    const s = await auth.status();
    if (s.state !== 'paired' || !s.organizationId) throw new NotPairedError(s.reason);
    return s.organizationId;
  };
}

/** Presigned PUT transport for the HTTP client: checksum pre-check, then fetch (no bearer) with retry/backoff. */
export function httpStorageTransport(opts: {
  allowLocalHttp: boolean;
  retry?: Partial<RetryPolicy>;
  inner?: StorageTransport;
}): StorageTransport {
  const inner = opts.inner ?? createFetchTransport({ allowLocalHttp: opts.allowLocalHttp });
  return verifyingStorage(storageWithRetry(inner, opts.retry));
}
