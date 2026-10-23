import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MAX_CHUNK_BYTES, MAX_CHUNKS, MAX_DURATION_MS } from '../constants.js';
import { MediaMimeType, PresignedUrlString, RecordingStatus } from '../domain/media.js';

/**
 * Chunked recording upload (extension/desktop capture), matching apps/extension UploadClient:
 *   POST /orgs/:organizationId/recording-sessions               InitRecordingSessionRequest     -> InitRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/chunks                   ChunkUploadUrlRequest           -> ChunkUploadUrlResponse (then PUT bytes)
 *   POST /recording-sessions/:sessionId/complete                 CompleteRecordingSessionRequest -> CompleteRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/abort                    AbortRecordingSessionRequest    -> 204
 */
/** Chunk limits live in constants.ts (also exported from `@meetops/contracts/types`). */
export {
  CHUNK_UPLOAD_URL_TTL_SECONDS, MAX_CHUNK_BYTES, MAX_CHUNKS, MAX_DURATION_MS, MAX_RECORDING_CHUNKS, MAX_RECORDING_SESSION_BYTES,
} from '../constants.js';

const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' });

const strict = { additionalProperties: false } as const;

/** Capture source. Extensible: add members via a contracts PR. */
export const RecordingSource = Type.Union([Type.Literal('tab')]);
export type RecordingSource = Static<typeof RecordingSource>;

export const InitRecordingSessionRequest = Type.Object(
  {
    mimeType: MediaMimeType,
    startedAt: IsoDateTime,
    source: RecordingSource,
    meetingId: Id,
  },
  strict,
);
export type InitRecordingSessionRequest = Static<typeof InitRecordingSessionRequest>;
export const InitRecordingSessionResponse = Type.Object({ sessionId: Id });
export type InitRecordingSessionResponse = Static<typeof InitRecordingSessionResponse>;

/**
 * Request a presigned PUT for one chunk.
 *
 * The API signs `Content-Length: sizeBytes` (and, when given, the sha256 checksum, e.g. `x-amz-checksum-sha256`)
 * into the presigned request, and returns them in `upload.headers`, so the client can't upload a different size or body.
 * The API refuses to issue a URL once the session's running total plus `sizeBytes` would exceed
 * MAX_RECORDING_SESSION_BYTES, or when `seq` is out of range or already completed.
 */
export const ChunkUploadUrlRequest = Type.Object(
  {
    seq: Type.Integer({ minimum: 0, maximum: MAX_CHUNKS - 1 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_CHUNK_BYTES }),
    sha256: Type.Optional(Sha256Hex),
  },
  strict,
);
export type ChunkUploadUrlRequest = Static<typeof ChunkUploadUrlRequest>;
/** S3 checksum header. Its value is the **base64** sha256 digest of the chunk body. */
export const CHECKSUM_SHA256_HEADER = 'x-amz-checksum-sha256';

/**
 * Presigned PUT whose signature covers the headers the client must send verbatim.
 * `headers['content-length']` always equals the requested `sizeBytes`. When the request carried `sha256`,
 * `headers['x-amz-checksum-sha256']` (base64 of the same digest) is present and signed too. Other signed headers
 * (e.g. `content-type`) may also appear.
 */
export const SignedPutUpload = Type.Object(
  {
    url: PresignedUrlString,
    method: Type.Literal('PUT'),
    headers: Type.Object(
      {
        'content-length': Type.String({ pattern: '^[1-9][0-9]{0,9}$' }),
        [CHECKSUM_SHA256_HEADER]: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' })),
      },
      { additionalProperties: Type.String({ maxLength: 4096 }) },
    ),
    expiresAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type SignedPutUpload = Static<typeof SignedPutUpload>;

/** `upload.expiresAt` is at most CHUNK_UPLOAD_URL_TTL_SECONDS out. */
export const ChunkUploadUrlResponse = Type.Object({
  seq: Type.Integer({ minimum: 0, maximum: MAX_CHUNKS - 1 }),
  upload: SignedPutUpload,
});
export type ChunkUploadUrlResponse = Static<typeof ChunkUploadUrlResponse>;

export const CompletedChunk = Type.Object(
  { seq: Type.Integer({ minimum: 0, maximum: MAX_CHUNKS - 1 }), sha256: Sha256Hex, sizeBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHUNK_BYTES })) },
  strict,
);
export type CompletedChunk = Static<typeof CompletedChunk>;

/**
 * Finish the session. The server verifies that the stored chunks are exactly seq 0..chunkCount-1 with no gaps or
 * duplicates. It checks each chunk's stored size (and its sha256 and sizeBytes when `chunks` is given) against
 * what was signed, and checks that the total is at most MAX_RECORDING_SESSION_BYTES. Any mismatch fails the session.
 */
export const CompleteRecordingSessionRequest = Type.Object(
  {
    chunkCount: Type.Integer({ minimum: 1, maximum: MAX_CHUNKS }),
    chunks: Type.Optional(Type.Array(CompletedChunk, { minItems: 1, maxItems: MAX_CHUNKS })),
    durationMs: Type.Integer({ minimum: 0, maximum: MAX_DURATION_MS }),
  },
  strict,
);
export type CompleteRecordingSessionRequest = Static<typeof CompleteRecordingSessionRequest>;
export const CompleteRecordingSessionResponse = Type.Object({ status: RecordingStatus });
export type CompleteRecordingSessionResponse = Static<typeof CompleteRecordingSessionResponse>;

export const AbortReason = Type.Union([
  Type.Literal('user_stopped'),
  Type.Literal('consent_revoked'),
  Type.Literal('tab_closed'),
  Type.Literal('local_storage_exhausted'),
  Type.Literal('error'),
]);
export type AbortReason = Static<typeof AbortReason>;
export const AbortRecordingSessionRequest = Type.Object({ reason: AbortReason }, strict);
export type AbortRecordingSessionRequest = Static<typeof AbortRecordingSessionRequest>;
