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
    expect(() => storageMediaAdapters(fakeDb, { STORAGE_PROVIDER: 'minio' })).toThrow(
      /STORAGE_BUCKET/,
    );
  });

  it('off: dev/test keep the in-memory adapters, production leaves media unset', () => {
    const dev = defaultModuleDeps({}, { nodeEnv: 'test' });
    expect(dev.media?.files).toBeInstanceOf(InMemoryFileObjectRepository);
    expect(dev.media?.signer).toBeInstanceOf(FakeMediaSigner);
  });

  it('on with a database: uses the storage-backed adapters from the injected storageEnv', () => {
    const deps = defaultModuleDeps(
      {},
      {
        nodeEnv: 'development',
        databaseUrl: DB_URL,
        storageEnv: { MEDIA_STORAGE_ENABLED: 'true', ...STORAGE_ENV },
      },
    );
    expect(deps.media?.files).toBeInstanceOf(PrismaFileObjectRepository);
    expect(deps.media?.consents).toBeInstanceOf(PrismaConsentRepository);
    expect(deps.media?.signer).toBeInstanceOf(S3UploadSourceSigner);
    expect((deps.media?.signer as S3UploadSourceSigner).bucket).toBe('unit-bucket');
  });

  it('on without a database: refuses to start', () => {
    expect(() =>
      defaultModuleDeps({}, { nodeEnv: 'test', storageEnv: { MEDIA_STORAGE_ENABLED: 'true' } }),
    ).toThrow(/DATABASE_URL/);
  });

  it('#300 L-2: reads the flag and STORAGE_* from the injected env, never process.env', () => {
    // process.env says on (with a different bucket); the injected env says off -> in-memory media.
    vi.stubEnv('MEDIA_STORAGE_ENABLED', 'true');
    for (const [k, v] of Object.entries(STORAGE_ENV)) vi.stubEnv(k, v);
    vi.stubEnv('STORAGE_BUCKET', 'process-env-bucket');
    const off = defaultModuleDeps(
      {},
      { nodeEnv: 'development', databaseUrl: DB_URL, storageEnv: {} },
    );
    expect(off.media?.files).toBeInstanceOf(InMemoryFileObjectRepository);
    // Injected env on: its bucket wins over process.env's.
    const on = defaultModuleDeps(
      {},
      {
        nodeEnv: 'development',
        databaseUrl: DB_URL,
        storageEnv: { MEDIA_STORAGE_ENABLED: 'true', ...STORAGE_ENV },
      },
    );
    expect((on.media?.signer as S3UploadSourceSigner).bucket).toBe('unit-bucket');
    // Injected env on but process.env off: still on.
    vi.stubEnv('MEDIA_STORAGE_ENABLED', 'false');
    expect(() =>
      defaultModuleDeps({}, { nodeEnv: 'test', storageEnv: { MEDIA_STORAGE_ENABLED: 'true' } }),
    ).toThrow(/DATABASE_URL/);
  });

  it('an injected media override wins over the flag (tests keep the in-memory path)', () => {
    const media = inMemoryMediaAdapters();
    expect(
      defaultModuleDeps(
        { media },
        { nodeEnv: 'test', storageEnv: { MEDIA_STORAGE_ENABLED: 'true' } },
      ).media,
    ).toBe(media);
  });
});
