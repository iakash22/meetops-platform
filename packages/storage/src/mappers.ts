import type { FileObject, PresignedUrlDto, PublicFileObject } from '@meetops/contracts';
import type { PresignedUrl } from '@meetops/contracts/legacy';

/**
 * Client-facing presign DTO. contracts' PresignedUrlDto has no `fields`, which a presigned POST
 * needs; it is carried as an extra property until contracts adds it.
 */
export type PresignedUploadDto = PresignedUrlDto & { fields?: Record<string, string> };

/** Map an internal PresignedUrl (Date expiry) to the JSON-safe client DTO. */
export function toPresignedUrlDto(p: PresignedUrl): PresignedUploadDto {
  if (p.method === 'DELETE') throw new Error('DELETE presigns are not client-facing');
  const dto: PresignedUploadDto = { url: p.url, method: p.method, expiresAt: p.expiresAt.toISOString() };
  if (p.headers) dto.headers = p.headers;
  if (p.fields) dto.fields = p.fields;
  return dto;
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
