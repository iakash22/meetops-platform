import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { PresignedUrlDto } from '../domain/media.js';

/** 5 GiB maximum single upload. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/** POST /orgs/:organizationId/uploads */
export const CreateUploadRequest = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000]+$' }),
    mimeType: Type.String({ pattern: '^(audio|video)/[a-z0-9.+-]+$', maxLength: 100 }),
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
