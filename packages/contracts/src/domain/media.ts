import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

/** INTERNAL (api/worker only). Storage-provider independent object reference. Use PublicFileObject in responses. `provider` is a registry key (e.g. "s3", "minio", "local"). */
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

/** HTTPS URL. */
export const HttpsUrl = Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 });

/** Time-limited presigned URL returned to clients (JSON-safe; ISO expiry). */
export const PresignedUrlDto = Type.Object({
  url: HttpsUrl,
  method: Type.Union([Type.Literal('GET'), Type.Literal('PUT'), Type.Literal('POST')]),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  expiresAt: IsoDateTime,
});
export type PresignedUrlDto = Static<typeof PresignedUrlDto>;

/**
 * Client-facing file. Never exposes storage provider, bucket or key;
 * content is fetched via the short-lived presigned `download` URL.
 */
export const PublicFileObject = Type.Object({
  id: Id,
  organizationId: Id,
  mimeType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  createdAt: IsoDateTime,
  download: Type.Optional(PresignedUrlDto),
});
export type PublicFileObject = Static<typeof PublicFileObject>;

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
  file: PublicFileObject,
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  status: RecordingStatus,
  createdAt: IsoDateTime,
});
export type Recording = Static<typeof Recording>;

/** Upload cap shared by direct uploads and recording sessions: 2 GB (decimal). */
export const MAX_MEDIA_BYTES = 2_000_000_000;

/** Explicit allowlist of accepted media MIME types. */
export const ALLOWED_MEDIA_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'video/webm',
  'video/mp4',
] as const;
export type AllowedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/**
 * An allowlisted MIME type, optionally followed by a `;codecs=` parameter (e.g. `audio/webm;codecs=opus`).
 * No other parameters are accepted.
 */
export const MediaMimeType = Type.String({
  maxLength: 100,
  pattern: `^(${ALLOWED_MEDIA_MIME_TYPES.map(escapeRe).join('|')})(;\\s?codecs="?[A-Za-z0-9.,+\\- ]{1,60}"?)?$`,
});
export type MediaMimeType = Static<typeof MediaMimeType>;
