/**
 * Response overrides forced onto every presigned GET (security review B 4.1). Stored objects are untrusted user
 * uploads, so a download URL must never let the browser render them inline or sniff a different type:
 * `Content-Disposition: attachment` always, and `Content-Type` is a fixed allowlisted media type (parameters such as
 * `;codecs=` stripped) or `application/octet-stream`.
 */
export const DOWNLOAD_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'video/webm',
  'video/mp4',
  'application/json',
] as const;

export const FALLBACK_DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/** Allowlisted base type of `contentType`, else application/octet-stream. */
export function downloadContentType(contentType: string | undefined): string {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return (DOWNLOAD_CONTENT_TYPES as readonly string[]).includes(base)
    ? base
    : FALLBACK_DOWNLOAD_CONTENT_TYPE;
}

/** S3 GetObject response overrides for a presigned download. The object key never appears in the filename. */
export function downloadResponseOverrides(contentType: string | undefined): {
  ResponseContentDisposition: 'attachment';
  ResponseContentType: string;
} {
  return {
    ResponseContentDisposition: 'attachment',
    ResponseContentType: downloadContentType(contentType),
  };
}

/** Result of S3StorageService.verifyBucketPrivate(). */
type PrivacyStatus = { status: 'private' | 'public' | 'unknown' };

/**
 * Fail-closed startup gate for the media bucket: throws when the bucket is public. `unknown` (provider lacks the
 * policy/ACL APIs, e.g. R2) is allowed only when `allowUnknown` is set, so it is an explicit operator decision.
 */
export function assertBucketPrivate(r: PrivacyStatus, opts: { allowUnknown?: boolean } = {}): void {
  if (r.status === 'public') throw new Error('Media bucket is public; refusing to start');
  if (r.status === 'unknown' && !opts.allowUnknown)
    throw new Error('Media bucket privacy could not be verified; set allowUnknown to accept');
}
