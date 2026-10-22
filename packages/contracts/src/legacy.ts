/**
 * @deprecated Phase 0 hand-written types, kept only for migration. Use PublicFileObject / PresignedUrlDto
 * (and the internal FileObject) from '@meetops/contracts'. Removal planned in 0.3.0.
 */
export type EmailAddress = {
  name?: string;
  email: string;
};

export type EmailMessage = {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
};

/** @deprecated Use FileObject (internal) or PublicFileObject. Removal in 0.3.0. */
export type StorageObjectMetadata = {
  key: string;
  bucket: string;
  size: number;
  contentType?: string;
  etag?: string;
  checksumSha256?: string;
  createdAt?: Date;
  updatedAt?: Date;
  custom?: Record<string, string>;
};

/** @deprecated Use PresignedUrlDto. Removal in 0.3.0. */
export type PresignedUrl = {
  url: string;
  expiresAt: Date;
  method: "GET" | "PUT" | "POST" | "DELETE";
  headers?: Record<string, string>;
  fields?: Record<string, string>;
};
