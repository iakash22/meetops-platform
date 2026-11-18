/**
 * Real HTTP client for the chunked recording upload API (contracts `api/recording-sessions.ts`, 0.3.x):
 *
 *   POST /orgs/:organizationId/recording-sessions   InitRecordingSessionRequest     -> InitRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/chunks       ChunkUploadUrlRequest           -> ChunkUploadUrlResponse
 *   PUT  <presigned url>                             chunk bytes with the signed headers (no bearer)
 *   POST /recording-sessions/:sessionId/complete     CompleteRecordingSessionRequest -> CompleteRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/abort        AbortRecordingSessionRequest    -> 204
 *
 * API routes go through `ApiFetch`, which in production is `AuthService.apiFetch` (ADR-005: bearer with aud=extension,
 * exact API origin only, one refresh on 401). Presigned PUTs go through a StorageTransport, which never carries a
 * bearer. Gated behind WXT_FEATURE_HTTP_UPLOAD (on in development builds, off in production
 * builds and in tests; see httpUploadEnabled).
 *
 * This module never logs, and error messages carry only the operation, HTTP status and API error code (never
 * headers, bodies or server messages), so no token can leak through them.
 */
import type {
  AbortRecordingSessionRequest,
  ApiErrorEnvelope,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
} from '@meetops/contracts/types';
import {
  isNetworkError,
  isRetryableStatus,
  parseRetryAfter,
  retryPolicy,
  withRetry,
  type RetryDecision,
  type RetryPolicy,
} from './retry.js';
import { fillPath, RECORDING_SESSION_ROUTES } from './api-paths.js';
import { hexToBase64, sha256Hex, type StorageTransport, type UploadClient } from './upload.js';

/** Typed fetch layer for API routes: a path on the API origin plus init (AuthService.apiFetch in production). */
export type ApiFetch = (path: string, init: RequestInit) => Promise<Response>;

/** Recording-session routes (#197/#206), resolved from the API's route templates. */
export const RECORDING_SESSION_PATHS = {
  init: (organizationId: string) => fillPath(RECORDING_SESSION_ROUTES.init, { organizationId }),
  chunks: (sessionId: string) => fillPath(RECORDING_SESSION_ROUTES.chunks, { sessionId }),
  complete: (sessionId: string) => fillPath(RECORDING_SESSION_ROUTES.complete, { sessionId }),
  abort: (sessionId: string) => fillPath(RECORDING_SESSION_ROUTES.abort, { sessionId }),
} as const;

export type UploadOp =
  'initSession' | 'requestChunkUrl' | 'complete' | 'abort' | 'initUpload' | 'completeUpload';

/** Runtime schema checks (TypeBox Value.Check in production, see auth/validate.ts) for every request and response. */
export interface UploadValidators {
  initRequest: (v: unknown) => v is InitRecordingSessionRequest;
  chunkUrlRequest: (v: unknown) => v is ChunkUploadUrlRequest;
  completeRequest: (v: unknown) => v is CompleteRecordingSessionRequest;
  abortRequest: (v: unknown) => v is AbortRecordingSessionRequest;
  initResponse: (v: unknown) => v is InitRecordingSessionResponse;
  chunkUrlResponse: (v: unknown) => v is ChunkUploadUrlResponse;
  completeResponse: (v: unknown) => v is CompleteRecordingSessionResponse;
  apiError: (v: unknown) => v is ApiErrorEnvelope;
}

/** A non-2xx API answer. `code` is the contracts ApiErrorCode, or INVALID_RESPONSE when the body is not an envelope. */
export class UploadApiError extends Error {
  constructor(
    readonly op: UploadOp,
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs?: number,
    /** Contracts `error.reason` (e.g. RECORDING_SESSION_CLOSED), when the server sent one. */
    readonly reason?: string,
  ) {
    super(`Upload API ${op} failed: HTTP ${status} ${code}`);
    this.name = 'UploadApiError';
  }
  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

/** A request or response that does not match the contracts schema. Never retried. */
export class UploadContractError extends Error {
  constructor(op: UploadOp, what: 'request' | 'response') {
    super(`Upload API ${op} ${what} failed contract validation`);
    this.name = 'UploadContractError';
  }
}

/**
 * The chunk body does not hash to the signed `x-amz-checksum-sha256`. Storage would reject it (400 BadDigest) and the
 * server's complete() would fail the session, so the PUT is not attempted. Never retried.
 */
export class ChunkChecksumMismatchError extends Error {
  constructor() {
    super('Chunk body does not match its signed sha256 checksum');
    this.name = 'ChunkChecksumMismatchError';
  }
}

/** Retry transient failures: network errors and 408/429/5xx (honouring Retry-After). Everything else is final. */
export function classifyUploadError(err: unknown): RetryDecision {
  if (err instanceof UploadApiError)
    return { retry: err.retryable, retryAfterMs: err.retryAfterMs };
  return { retry: isNetworkError(err) };
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;

export interface HttpUploadClientDeps {
  api: ApiFetch;
  /** Organization of the paired token (ADR-005: tokens are org-scoped; the path org must match it). */
  organizationId: () => Promise<string>;
  /** Presigned PUT transport (no bearer). Wrap it with storageWithRetry()/verifyingStorage() as needed. */
  storage: StorageTransport;
  validators: UploadValidators;
  retry?: Partial<RetryPolicy>;
}

export class HttpUploadClient implements UploadClient {
  /**
   * A 2xx presigned PUT with a signed content-length and x-amz-checksum-sha256 means object storage durably holds
   * exactly these bytes, so the drain may delete the local copy.
   */
  readonly durable: boolean = true;
  readonly storage: StorageTransport;
  private readonly policy: RetryPolicy;

  constructor(private readonly d: HttpUploadClientDeps) {
    this.storage = d.storage;
    this.policy = retryPolicy(d.retry);
  }

  async initSession(req: InitRecordingSessionRequest): Promise<InitRecordingSessionResponse> {
    if (!this.d.validators.initRequest(req))
      throw new UploadContractError('initSession', 'request');
    const orgId = await this.d.organizationId();
    // Retried like the others: a lost response can leave an orphan open session server-side, which the server
    // expires; contracts have no idempotency key for init yet (follow-up).
    return this.post(
      'initSession',
      RECORDING_SESSION_PATHS.init(orgId),
      req,
      this.d.validators.initResponse,
    );
  }

  async requestChunkUrl(
    sessionId: string,
    req: ChunkUploadUrlRequest,
  ): Promise<ChunkUploadUrlResponse> {
    if (!this.d.validators.chunkUrlRequest(req))
      throw new UploadContractError('requestChunkUrl', 'request');
    const res = await this.post(
      'requestChunkUrl',
      RECORDING_SESSION_PATHS.chunks(sessionId),
      req,
      this.d.validators.chunkUrlResponse,
    );
    if (res.seq !== req.seq) throw new UploadContractError('requestChunkUrl', 'response');
    // Contracts: the API always signs the checksum, base64 of the request's hex sha256.
    if (res.upload.headers['x-amz-checksum-sha256'] !== hexToBase64(req.sha256)) {
      throw new ChunkChecksumMismatchError();
    }
    return res;
  }

  async complete(
    sessionId: string,
    req: CompleteRecordingSessionRequest,
  ): Promise<CompleteRecordingSessionResponse> {
    if (!this.d.validators.completeRequest(req))
      throw new UploadContractError('complete', 'request');
    return this.post(
      'complete',
      RECORDING_SESSION_PATHS.complete(sessionId),
      req,
      this.d.validators.completeResponse,
    );
  }

  /**
   * Abort is best effort: 404 (unknown here, or another tenant's id) and 409 (already closed) mean there is nothing
   * left to abort, so they resolve.
   */
  async abort(sessionId: string, req: AbortRecordingSessionRequest): Promise<void> {
    if (!this.d.validators.abortRequest(req)) throw new UploadContractError('abort', 'request');
    try {
      await this.post('abort', RECORDING_SESSION_PATHS.abort(sessionId), req, undefined);
    } catch (err) {
      if (err instanceof UploadApiError && (err.status === 404 || err.status === 409)) return;
      throw err;
    }
  }

  private post<T>(
    op: UploadOp,
    path: string,
    body: unknown,
    check: (v: unknown) => v is T,
  ): Promise<T>;
  private post(op: UploadOp, path: string, body: unknown, check: undefined): Promise<void>;
  private post<T>(
    op: UploadOp,
    path: string,
    body: unknown,
    check: ((v: unknown) => v is T) | undefined,
  ): Promise<T | void> {
    return withRetry(
      async () => {
        const res = await this.d.api(path, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        if (!res.ok) {
          const json: unknown = await res.json().catch(() => undefined);
          const env = this.d.validators.apiError(json) ? json : undefined;
          const code = env ? env.error.code : 'INVALID_RESPONSE';
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.policy.now());
          throw new UploadApiError(op, res.status, code, retryAfter, env?.error.reason);
        }
        if (!check) return;
        const json: unknown = await res.json().catch(() => undefined);
        if (!check(json)) throw new UploadContractError(op, 'response');
        return json;
      },
      classifyUploadError,
      this.policy,
    );
  }
}

const header = (h: Record<string, string>, name: string) =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];

/**
 * Check the body against the signed `x-amz-checksum-sha256` before uploading, so a stale stored digest or corrupted
 * local bytes fail fast with ChunkChecksumMismatchError instead of a storage 400 / failed session.
 */
export function verifyingStorage(inner: StorageTransport): StorageTransport {
  return async (req) => {
    const signed = header(req.headers, 'x-amz-checksum-sha256');
    if (signed === undefined) throw new ChunkChecksumMismatchError();
    if (hexToBase64(await sha256Hex(req.body)) !== signed) throw new ChunkChecksumMismatchError();
    return inner(req);
  };
}

class RetryableStorageStatus extends Error {
  constructor(readonly status: number) {
    super(`Storage PUT failed with HTTP ${status}`);
  }
}

/**
 * Retry a presigned PUT on network errors and transient statuses (S3 503 SlowDown, 500, 429...). 403 (expired or
 * rejected signature) is returned at once so uploadChunk can re-request the URL; other statuses are returned as-is.
 */
export function storageWithRetry(
  inner: StorageTransport,
  retry: Partial<RetryPolicy> = {},
): StorageTransport {
  const p = retryPolicy(retry);
  return async (req) => {
    try {
      return await withRetry(
        async () => {
          const r = await inner(req);
          if (isRetryableStatus(r.status)) throw new RetryableStorageStatus(r.status);
          return r;
        },
        (err) => ({ retry: err instanceof RetryableStorageStatus || isNetworkError(err) }),
        p,
      );
    } catch (err) {
      if (err instanceof RetryableStorageStatus) return { status: err.status };
      throw err;
    }
  };
}
