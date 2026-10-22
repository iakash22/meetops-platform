import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { MAX_MEDIA_BYTES, MediaMimeType, PresignedUrlDto } from '../domain/media.js';

/** Standard base64 encoding of a 32-byte sha256 digest (S3 `x-amz-checksum-sha256` format). */
export const Sha256Base64 = Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' });

/** 1.4 GB maximum single upload (= MAX_MEDIA_BYTES). */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES;

/** POST /orgs/:organizationId/uploads */
export const CreateUploadRequest = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000]+$' }),
    mimeType: MediaMimeType,
    sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
    /** REQUIRED: standard base64 (44 chars, padded) sha256 digest of the whole file; signed into the upload. */
    checksumSha256: Sha256Base64,
    meetingId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type CreateUploadRequest = Static<typeof CreateUploadRequest>;

export const CreateUploadResponse = Type.Object({
  fileObjectId: Id,
  upload: PresignedUrlDto,
});
export type CreateUploadResponse = Static<typeof CreateUploadResponse>;
