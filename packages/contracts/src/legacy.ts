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

export type PresignedUrl = {
  url: string;
  expiresAt: Date;
  method: "GET" | "PUT" | "POST" | "DELETE";
  headers?: Record<string, string>;
  fields?: Record<string, string>;
};
