import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import {
  CONSENT_ERROR_REASONS,
  MAX_MEDIA_BYTES,
  MAX_PRESIGNED_GET_TTL_SECONDS,
} from '../constants.js';
import {
  FileObjectScanStatus,
  MediaMimeType,
  PresignedUrlDto,
  PresignedUrlString,
  PublicFileObject,
} from '../domain/media.js';
import { ConsentAttestationInput } from './consent.js';

/** Standard base64 encoding of a 32-byte sha256 digest (S3 `x-amz-checksum-sha256` format). */
export const Sha256Base64 = Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' });

/** 1.4 GB maximum single upload (= MAX_MEDIA_BYTES). */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES;

/** See `filename` below. */
export const FILENAME_PATTERN =
  '^[^/\\\\\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890\\u0891\\u08E2\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB]+$';

/** Full check, incl. astral code points: no Cc, Cf, Zl, Zp, Co, Cs, `/` or `\\`, and the FILENAME_PATTERN. */
export function isSafeUploadFilename(name: string): boolean {
  return (
    new RegExp(FILENAME_PATTERN, 'u').test(name) &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u.test(name)
  );
}

const uploadFields = {
  /**
   * Display name only (never part of a storage key). Security review B 4.3 + #270 L-1. The pattern (BMP, valid with
   * and without the regex `u` flag, so TypeBox Value and Ajv agree) rejects `/`, `\`, C0/C1 controls, DEL, line and
   * paragraph separators and every BMP format (Cf) character: soft hyphen, Arabic/Syriac marks, Mongolian vowel
   * separator, zero-width space/joiners and LRM/RLM (U+200B-U+200F), bidi embeddings/overrides/isolates
   * (U+202A-U+202E, U+2066-U+2069), word joiner and invisible operators (U+2060-U+2064, U+206A-U+206F), BOM / ZWNBSP
   * (U+FEFF) and interlinear annotations (U+FFF9-U+FFFB). Astral Cf (e.g. tag characters) is caught by
   * isSafeUploadFilename, which the API also enforces. Encode it (RFC 5987 `filename*=`) in headers.
   */
  filename: Type.String({
    minLength: 1,
    maxLength: 255,
    pattern: FILENAME_PATTERN,
  }),
  mimeType: MediaMimeType,
  sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
  /** REQUIRED: standard base64 (44 chars, padded) sha256 digest of the whole file; signed into the upload. */
  checksumSha256: Sha256Base64,
  meetingId: Type.Optional(Id),
};

/**
 * v0.4.1: `POST /orgs/:organizationId/uploads` request body, validated by the API route. Same fields as the v0.4.0
 * CreateUploadRequest plus a REQUIRED `consent` attestation (G11). A body without `consent` fails this schema and the
 * API answers 422 `VALIDATION_FAILED` + `reason: 'CONSENT_REQUIRED'` before any FileObject or presigned URL exists.
 */
export const InitUploadRequest = Type.Object(
  { ...uploadFields, consent: ConsentAttestationInput },
  { additionalProperties: false },
);
export type InitUploadRequest = Static<typeof InitUploadRequest>;

/**
 * @deprecated since 0.4.1: the v0.4.0 upload body, without `consent`. The API validates InitUploadRequest and rejects
 * this shape with 422 CONSENT_REQUIRED. Kept only so existing clients (apps/web) compile until they add the consent
 * step; it will be removed in 0.5.0.
 */
export const CreateUploadRequest = Type.Object(uploadFields, { additionalProperties: false });
/** @deprecated since 0.4.1: use InitUploadRequest. */
export type CreateUploadRequest = Static<typeof CreateUploadRequest>;

/** Response of `POST /orgs/:organizationId/uploads` (both request shapes). */
export const CreateUploadResponse = Type.Object({
  fileObjectId: Id,
  upload: PresignedUrlDto,
});
export type CreateUploadResponse = Static<typeof CreateUploadResponse>;
/** v0.4.1: alias of CreateUploadResponse, named to match InitUploadRequest. */
export const InitUploadResponse = CreateUploadResponse;
export type InitUploadResponse = CreateUploadResponse;

/**
 * v0.5.0: `POST /orgs/:organizationId/uploads/:fileObjectId/complete` (CONSENT_UPLOAD_PATHS.uploadComplete).
 * Body is an empty strict object (the server already holds the signed size, checksum and attestation). The server
 * verifies the stored object's size and checksum, then the stored consent attestation. On a consent failure it answers
 * 422 `VALIDATION_FAILED` + `reason` from UPLOAD_COMPLETE_CONSENT_ERROR_REASONS (ConsentErrorEnvelope) and enqueues no
 * media job; the FileObject stays unprocessed.
 */
export const CompleteUploadRequest = Type.Object({}, { additionalProperties: false });
export type CompleteUploadRequest = Static<typeof CompleteUploadRequest>;

/** Consent reasons upload complete can return (= CONSENT_ERROR_REASONS). */
export const UPLOAD_COMPLETE_CONSENT_ERROR_REASONS = CONSENT_ERROR_REASONS;

/** 200 response of upload complete. `scanStatus` starts `pending`; the media job is enqueued only on success. */
export const CompleteUploadResponse = Type.Object(
  { fileObject: PublicFileObject, scanStatus: FileObjectScanStatus },
  { additionalProperties: false },
);
export type CompleteUploadResponse = Static<typeof CompleteUploadResponse>;

/**
 * v0.5.0: `GET /orgs/:organizationId/uploads/:fileObjectId/download-url` (CONSENT_UPLOAD_PATHS.uploadDownloadUrl).
 * A presigned GET. `expiresIn` (seconds) is 1..MAX_PRESIGNED_GET_TTL_SECONDS (300) and `expiresAt` = issue time + expiresIn.
 * 404 for other-org ids or a FileObject whose scanStatus is not `clean`.
 */
export const DownloadUrlResponse = Type.Object(
  {
    url: PresignedUrlString,
    method: Type.Literal('GET'),
    expiresIn: Type.Integer({ minimum: 1, maximum: MAX_PRESIGNED_GET_TTL_SECONDS }),
    expiresAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type DownloadUrlResponse = Static<typeof DownloadUrlResponse>;
