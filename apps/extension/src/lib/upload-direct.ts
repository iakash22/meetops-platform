/**
 * Single-file direct upload (contracts v0.4.1 `POST /orgs/:organizationId/uploads`, served by feat/api-uploads):
 *   POST /orgs/:org/uploads                         InitUploadRequest (consent REQUIRED) -> 201 InitUploadResponse
 *   PUT  <presigned url>                            whole recording, signed headers as given (no bearer)
 *   POST /orgs/:org/uploads/:fileObjectId/complete  {} -> 200 { fileObject, scanStatus }
 *
 * Used for a finished recording while the chunked recording-session routes are not served. Gated behind
 * WXT_FEATURE_DIRECT_UPLOAD (off by default). Never logs; errors carry only op, status and API error code.
 */
import type {
  ConsentAttestationInput,
  InitUploadRequest,
  InitUploadResponse,
} from '@meetops/contracts/types';
import { CONSENT_UPLOAD_PATHS, MAX_MEDIA_BYTES } from '@meetops/contracts/types';
import { fillPath } from './api-paths.js';
import { parseRetryAfter, retryPolicy, withRetry, type RetryPolicy } from './retry.js';
import { classifyUploadError, UploadApiError, type ApiFetch } from './upload-http.js';
import { hexToBase64, sha256Hex, type StorageTransport } from './upload.js';

/** Resolved from contracts CONSENT_UPLOAD_PATHS (#196). */
export const DIRECT_UPLOAD_PATHS = {
  init: (organizationId: string) => fillPath(CONSENT_UPLOAD_PATHS.uploads, { organizationId }),
  complete: (organizationId: string, fileObjectId: string) =>
    fillPath(CONSENT_UPLOAD_PATHS.uploadComplete, { organizationId, fileObjectId }),
} as const;

export type DirectUploadOp = 'initUpload' | 'put' | 'completeUpload';

export class DirectUploadError extends Error {
  constructor(
    readonly op: DirectUploadOp,
    readonly reason: 'too_large' | 'empty' | 'response' | 'storage',
    readonly status?: number,
  ) {
    super(`Direct upload ${op} failed (${reason}${status ? ` ${status}` : ''})`);
    this.name = 'DirectUploadError';
  }
}

export interface DirectUploadInput {
  blob: Blob;
  filename: string;
  mimeType: string;
  meetingId?: string;
  consent: ConsentAttestationInput;
}

export interface DirectUploadResult {
  fileObjectId: string;
  scanStatus: string;
}

export interface DirectUploadDeps {
  api: ApiFetch;
  organizationId: () => Promise<string>;
  storage: StorageTransport;
  isInitResponse: (v: unknown) => v is InitUploadResponse;
  apiErrorCode?: (v: unknown) => string | undefined;
  retry?: Partial<RetryPolicy>;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;

const isCompleteResponse = (v: unknown): v is { fileObject: { id: string }; scanStatus: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { scanStatus?: unknown }).scanStatus === 'string' &&
  typeof (v as { fileObject?: { id?: unknown } }).fileObject?.id === 'string';

export class DirectUploadClient {
  private readonly policy: RetryPolicy;
  constructor(private readonly d: DirectUploadDeps) {
    this.policy = retryPolicy(d.retry);
  }

  async upload(input: DirectUploadInput): Promise<DirectUploadResult> {
    const size = input.blob.size;
    if (size < 1) throw new DirectUploadError('initUpload', 'empty');
    if (size > MAX_MEDIA_BYTES) throw new DirectUploadError('initUpload', 'too_large');
    const org = await this.d.organizationId();
    const body: InitUploadRequest = {
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: size,
      checksumSha256: hexToBase64(await sha256Hex(input.blob)),
      ...(input.meetingId ? { meetingId: input.meetingId } : {}),
      consent: input.consent,
    };
    const init = await this.post('initUpload', DIRECT_UPLOAD_PATHS.init(org), body);
    if (!this.d.isInitResponse(init)) throw new DirectUploadError('initUpload', 'response');

    const put = await this.d.storage({
      url: init.upload.url,
      method: 'PUT',
      headers: init.upload.headers ?? {},
      body: input.blob,
    });
    if (put.status < 200 || put.status >= 300)
      throw new DirectUploadError('put', 'storage', put.status);

    const done = await this.post(
      'completeUpload',
      DIRECT_UPLOAD_PATHS.complete(org, init.fileObjectId),
      {},
    );
    if (!isCompleteResponse(done)) throw new DirectUploadError('completeUpload', 'response');
    return { fileObjectId: done.fileObject.id, scanStatus: done.scanStatus };
  }

  private post(op: DirectUploadOp, path: string, body: unknown): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await this.d.api(path, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const json: unknown = await res.json().catch(() => undefined);
        if (!res.ok) {
          const code = this.d.apiErrorCode?.(json) ?? 'INVALID_RESPONSE';
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.policy.now());
          throw new UploadApiError(op === 'put' ? 'initUpload' : op, res.status, code, retryAfter);
        }
        return json;
      },
      classifyUploadError,
      this.policy,
    );
  }
}
