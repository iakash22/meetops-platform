import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { MAX_MEDIA_BYTES } from '../constants.js';
import { MediaMimeType, PresignedUrlDto } from '../domain/media.js';
import { ConsentAttestationInput } from './consent.js';

/** Standard base64 encoding of a 32-byte sha256 digest (S3 `x-amz-checksum-sha256` format). */
export const Sha256Base64 = Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' });

/** 1.4 GB maximum single upload (= MAX_MEDIA_BYTES). */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES;

const uploadFields = {
  filename: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000]+$' }),
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
