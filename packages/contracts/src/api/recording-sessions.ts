import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { PresignedUrlDto, RecordingStatus } from '../domain/media.js';

/**
 * Chunked recording upload (extension/desktop capture), matching apps/extension UploadClient:
 *   POST /orgs/:organizationId/recording-sessions               InitRecordingSessionRequest     -> InitRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/chunks                   ChunkUploadUrlRequest           -> ChunkUploadUrlResponse (then PUT bytes)
 *   POST /recording-sessions/:sessionId/complete                 CompleteRecordingSessionRequest -> CompleteRecordingSessionResponse
 *   POST /recording-sessions/:sessionId/abort                    AbortRecordingSessionRequest    -> 204
 */
export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
/** 64 MiB per chunk (5 s timeslices are far smaller; this is an abuse ceiling). */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** 5 GiB per recording session, enforced server-side across all chunks. */
export const MAX_RECORDING_SESSION_BYTES = 5 * 1024 * 1024 * 1024;
/** Upper bound on chunk count (5 GiB / smallest reasonable chunk). */
export const MAX_RECORDING_CHUNKS = 100_000;

const strict = { additionalProperties: false } as const;

/** Capture source. Extensible: add members via a contracts PR. */
export const RecordingSource = Type.Union([Type.Literal('tab')]);
export type RecordingSource = Static<typeof RecordingSource>;

export const InitRecordingSessionRequest = Type.Object(
  {
    mimeType: Type.String({ pattern: '^(audio|video)/[a-z0-9.+-]+(;\\s*codecs=[A-Za-z0-9.,"\\s-]+)?$', maxLength: 100 }),
    startedAt: IsoDateTime,
    source: RecordingSource,
    meetingId: Type.Optional(Id),
  },
  strict,
);
export type InitRecordingSessionRequest = Static<typeof InitRecordingSessionRequest>;
export const InitRecordingSessionResponse = Type.Object({ sessionId: Id });
export type InitRecordingSessionResponse = Static<typeof InitRecordingSessionResponse>;

export const ChunkUploadUrlRequest = Type.Object(
  { seq: Type.Integer({ minimum: 0, maximum: MAX_RECORDING_CHUNKS - 1 }) },
  strict,
);
export type ChunkUploadUrlRequest = Static<typeof ChunkUploadUrlRequest>;
/** `upload.method` is always PUT; `upload.expiresAt` is at most CHUNK_UPLOAD_URL_TTL_SECONDS out. */
export const ChunkUploadUrlResponse = Type.Object({
  seq: Type.Integer({ minimum: 0 }),
  upload: Type.Composite([Type.Omit(PresignedUrlDto, ['method']), Type.Object({ method: Type.Literal('PUT') })]),
});
export type ChunkUploadUrlResponse = Static<typeof ChunkUploadUrlResponse>;

export const CompleteRecordingSessionRequest = Type.Object(
  {
    chunkCount: Type.Integer({ minimum: 1, maximum: MAX_RECORDING_CHUNKS }),
    durationMs: Type.Integer({ minimum: 0, maximum: 24 * 60 * 60 * 1000 }),
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
  Type.Literal('error'),
]);
export type AbortReason = Static<typeof AbortReason>;
export const AbortRecordingSessionRequest = Type.Object({ reason: AbortReason }, strict);
export type AbortRecordingSessionRequest = Static<typeof AbortRecordingSessionRequest>;
