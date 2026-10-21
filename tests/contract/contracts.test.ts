import { describe, expect, it } from 'vitest';
import { createFactories } from '../factories/index.js';
import { emailMessageSchema, presignedUrlSchema, storageObjectMetadataSchema } from './schemas.js';

describe('contracts: schema validation', () => {
  const f = createFactories({ seed: 123, tenantSlug: 'contract' });

  it('factory EmailMessage satisfies the schema', () => {
    expect(emailMessageSchema.safeParse(f.emailMessage()).success).toBe(true);
  });

  it('rejects an EmailMessage without recipients', () => {
    expect(emailMessageSchema.safeParse(f.emailMessage({ to: [] })).success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    const msg = f.emailMessage({ from: { email: 'not-an-email' } });
    expect(emailMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('factory StorageObjectMetadata satisfies the schema', () => {
    expect(storageObjectMetadataSchema.safeParse(f.storageObject()).success).toBe(true);
  });

  it('rejects negative object size', () => {
    expect(storageObjectMetadataSchema.safeParse(f.storageObject({ size: -1 })).success).toBe(false);
  });

  it('PresignedUrl only allows known HTTP methods', () => {
    const base = { url: 'https://s3.test/k', expiresAt: f.ctx.now };
    expect(presignedUrlSchema.safeParse({ ...base, method: 'PUT' }).success).toBe(true);
    expect(presignedUrlSchema.safeParse({ ...base, method: 'PATCH' }).success).toBe(false);
  });
});
