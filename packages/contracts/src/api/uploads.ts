import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { MAX_MEDIA_BYTES } from '../constants.js';
import { MediaMimeType, PresignedUrlDto } from '../domain/media.js';

/** 2 GB maximum single upload. */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES;

/** POST /orgs/:organizationId/uploads */
export const CreateUploadRequest = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000]+$' }),
    mimeType: MediaMimeType,
    sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
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
