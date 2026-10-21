import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

/** Storage-provider independent object reference. `provider` is a registry key (e.g. "s3", "minio", "local"). */
export const FileObject = Type.Object({
  id: Id,
  organizationId: Id,
  provider: Type.String({ minLength: 1 }),
  bucket: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  checksumSha256: Type.Optional(Type.String()),
  createdAt: IsoDateTime,
});
export type FileObject = Static<typeof FileObject>;

export const RecordingStatus = Type.Union([
  Type.Literal('uploading'),
  Type.Literal('uploaded'),
  Type.Literal('processing'),
  Type.Literal('ready'),
  Type.Literal('failed'),
]);
export type RecordingStatus = Static<typeof RecordingStatus>;

export const Recording = Type.Object({
  id: Id,
  meetingId: Id,
  file: FileObject,
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  status: RecordingStatus,
  createdAt: IsoDateTime,
});
export type Recording = Static<typeof Recording>;
