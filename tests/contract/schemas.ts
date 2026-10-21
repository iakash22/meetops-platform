import { z } from 'zod';
import type { EmailAddress, EmailMessage, PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';

// @meetops/contracts currently ships TypeScript types only (no runtime schemas).
// These zod mirrors live in tests/ until the contracts package owns them; the
// type assertions below fail typecheck if the two drift apart.
export const emailAddressSchema = z.object({ name: z.string().optional(), email: z.string().email() });

export const emailMessageSchema = z.object({
  from: emailAddressSchema,
  to: z.array(emailAddressSchema).min(1),
  cc: z.array(emailAddressSchema).optional(),
  bcc: z.array(emailAddressSchema).optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional()
});

export const storageObjectMetadataSchema = z.object({
  key: z.string().min(1),
  bucket: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().optional(),
  etag: z.string().optional(),
  checksumSha256: z.string().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  custom: z.record(z.string()).optional()
});

export const presignedUrlSchema = z.object({
  url: z.string().url(),
  expiresAt: z.date(),
  method: z.enum(['GET', 'PUT', 'POST', 'DELETE']),
  headers: z.record(z.string()).optional(),
  fields: z.record(z.string()).optional()
});

type Strip<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
type Same<A, B> = [Strip<A>] extends [Strip<B>] ? ([Strip<B>] extends [Strip<A>] ? true : false) : false;
type Assert<T extends true> = T;
export type _Checks = [
  Assert<Same<z.infer<typeof emailAddressSchema>, EmailAddress>>,
  Assert<Same<z.infer<typeof storageObjectMetadataSchema>, StorageObjectMetadata>>,
  Assert<Same<z.infer<typeof presignedUrlSchema>, PresignedUrl>>,
  Assert<keyof z.infer<typeof emailMessageSchema> extends keyof EmailMessage ? true : false>
];
