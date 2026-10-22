import type { FileObject, PresignedUrlDto, PublicFileObject, SignedPutUpload } from '@meetops/contracts';
import type { PresignedUrl } from '@meetops/contracts/legacy';

/** @deprecated contracts PresignedUrlDto now carries POST `fields`; kept as an alias. */
export type PresignedUploadDto = PresignedUrlDto;

/** Map an internal PresignedUrl (Date expiry) to the JSON-safe client DTO (POST requires fields). */
export function toPresignedUrlDto(p: PresignedUrl): PresignedUrlDto {
  const expiresAt = p.expiresAt.toISOString();
  const headers = p.headers ? { headers: p.headers } : {};
  if (p.method === 'POST') {
    if (!p.fields) throw new Error('POST presign requires fields');
    return { url: p.url, method: 'POST', fields: p.fields, expiresAt, ...headers };
  }
  if (p.method === 'DELETE') throw new Error('DELETE presigns are not client-facing');
  return { url: p.url, method: p.method, expiresAt, ...headers };
}

/** Map a session-chunk presign to contracts SignedPutUpload (ChunkUploadUrlResponse.upload). */
export function toSignedPutUpload(p: PresignedUrl): SignedPutUpload {
  if (p.method !== 'PUT' || !p.headers?.['content-length']) throw new Error('Not a signed PUT');
  return { url: p.url, method: 'PUT', headers: p.headers as SignedPutUpload['headers'], expiresAt: p.expiresAt.toISOString() };
}

/** Strip provider/bucket/key: the only shape that may leave the API. */
export function toPublicFileObject(f: FileObject, download?: PresignedUrl): PublicFileObject {
  const out: PublicFileObject = {
    id: f.id,
    organizationId: f.organizationId,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    createdAt: f.createdAt
  };
  if (download) out.download = toPresignedUrlDto(download);
  return out;
}
