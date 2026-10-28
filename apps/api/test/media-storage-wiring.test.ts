import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@meetops/database';
import { S3UploadSourceSigner } from '@meetops/storage';
import {
  defaultModuleDeps,
  inMemoryMediaAdapters,
  mediaStorageEnabled,
  storageMediaAdapters,
} from '../src/modules/index.js';
import {
  FakeMediaSigner,
  InMemoryFileObjectRepository,
} from '../src/modules/media/infrastructure/in-memory.js';
import {
  PrismaConsentRepository,
  PrismaFileObjectRepository,
} from '../src/modules/media/infrastructure/prisma.js';

// Placeholder values only: nothing here connects (Prisma and S3 are lazy, no query is issued).
const DB_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';
const STORAGE_ENV = {
  STORAGE_PROVIDER: 'minio',
  STORAGE_ENDPOINT: 'http://127.0.0.1:1',
  STORAGE_BUCKET: 'unit-bucket',
};
const fakeDb = {} as DatabaseClient;

afterEach(() => vi.unstubAllEnvs());

describe('MEDIA_STORAGE_ENABLED', () => {
  it('parses booleans and defaults to off', () => {
    expect(mediaStorageEnabled({})).toBe(false);
    expect(mediaStorageEnabled({ MEDIA_STORAGE_ENABLED: '' })).toBe(false);
    expect(mediaStorageEnabled({ MEDIA_STORAGE_ENABLED: 'false' })).toBe(false);
    expect(mediaStorageEnabled({ MEDIA_STORAGE_ENABLED: 'true' })).toBe(true);
    expect(mediaStorageEnabled({ MEDIA_STORAGE_ENABLED: ' ON ' })).toBe(true);
    expect(() => mediaStorageEnabled({ MEDIA_STORAGE_ENABLED: 'maybe' })).toThrow();
  });

  it('storageMediaAdapters wires S3 signer + Prisma file/consent repositories', () => {
    const m = storageMediaAdapters(fakeDb, STORAGE_ENV);
    expect(m.files).toBeInstanceOf(PrismaFileObjectRepository);
    expect(m.consents).toBeInstanceOf(PrismaConsentRepository);
    expect(m.signer).toBeInstanceOf(S3UploadSourceSigner);
    expect((m.signer as S3UploadSourceSigner).bucket).toBe('unit-bucket');
  });

  it('storageMediaAdapters refuses an incomplete storage config', () => {
    expect(() => storageMediaAdapters(fakeDb, { STORAGE_PROVIDER: 'minio' })).toThrow(/STORAGE_BUCKET/);
  });

  it('off: dev/test keep the in-memory adapters, production leaves media unset', () => {
    const dev = defaultModuleDeps({}, { nodeEnv: 'test' });
    expect(dev.media?.files).toBeInstanceOf(InMemoryFileObjectRepository);
    expect(dev.media?.signer).toBeInstanceOf(FakeMediaSigner);
  });

  it('on with a database: uses the storage-backed adapters', () => {
    vi.stubEnv('MEDIA_STORAGE_ENABLED', 'true');
    for (const [k, v] of Object.entries(STORAGE_ENV)) vi.stubEnv(k, v);
    const deps = defaultModuleDeps({}, { nodeEnv: 'development', databaseUrl: DB_URL });
    expect(deps.media?.files).toBeInstanceOf(PrismaFileObjectRepository);
    expect(deps.media?.consents).toBeInstanceOf(PrismaConsentRepository);
    expect(deps.media?.signer).toBeInstanceOf(S3UploadSourceSigner);
  });

  it('on without a database: refuses to start', () => {
    vi.stubEnv('MEDIA_STORAGE_ENABLED', 'true');
    expect(() => defaultModuleDeps({}, { nodeEnv: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('an injected media override wins over the flag (tests keep the in-memory path)', () => {
    vi.stubEnv('MEDIA_STORAGE_ENABLED', 'true');
    const media = inMemoryMediaAdapters();
    expect(defaultModuleDeps({ media }, { nodeEnv: 'test' }).media).toBe(media);
  });
});
