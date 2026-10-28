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
  InMemoryConsentRepository,
  InMemoryFileObjectRepository,
  InMemoryMediaJobQueue,
} from '../src/modules/media/infrastructure/in-memory.js';
import { reconcileStaleMedia } from '../src/modules/media/application/reconcile.js';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts';
import {
  PrismaConsentRepository,
  PrismaFileObjectRepository,
  PrismaRecordingSessionRepository,
} from '../src/modules/media/infrastructure/prisma.js';
import {
  BullMqMediaJobQueue,
  MEDIA_JOB_OPTIONS,
  mediaProcessingJobId,
} from '../src/modules/media/infrastructure/bullmq.js';

// Placeholder values only: nothing here connects (Prisma and S3 are lazy, no query is issued).
const DB_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';
const STORAGE_ENV = {
  REDIS_URL: 'redis://127.0.0.1:1',
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

  it('storageMediaAdapters wires S3 signer, Prisma repositories and the BullMQ queue', async () => {
    const m = storageMediaAdapters(fakeDb, STORAGE_ENV);
    expect(m.sessions).toBeInstanceOf(PrismaRecordingSessionRepository);
    expect(m.jobs).toBeInstanceOf(BullMqMediaJobQueue);
    await m.close();
    expect(m.files).toBeInstanceOf(PrismaFileObjectRepository);
    expect(m.consents).toBeInstanceOf(PrismaConsentRepository);
    expect(m.signer).toBeInstanceOf(S3UploadSourceSigner);
    expect((m.signer as S3UploadSourceSigner).bucket).toBe('unit-bucket');
  });

  it('storageMediaAdapters refuses to run without REDIS_URL (no silent in-memory queue)', () => {
    expect(() => storageMediaAdapters(fakeDb, { ...STORAGE_ENV, REDIS_URL: '' })).toThrow(
      /REDIS_URL/,
    );
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

  it('on with a database: uses the storage-backed adapters from the injected storageEnv', async () => {
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
    expect(deps.media?.jobs).toBeInstanceOf(BullMqMediaJobQueue);
    expect(deps.media?.sessions).toBeInstanceOf(PrismaRecordingSessionRepository);
    await deps.ownedMedia?.close();
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

describe('BullMqMediaJobQueue', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const SUB = '22222222-2222-4222-8222-222222222222';
  it('adds the job on MEDIA_QUEUE with the worker job options and a deterministic, colon-free id', async () => {
    const add = vi.fn(async () => undefined);
    const q = new BullMqMediaJobQueue({ add });
    const job = {
      kind: 'process_upload' as const,
      organizationId: ORG,
      subjectType: 'upload' as const,
      subjectId: SUB,
      consentAttestationId: SUB,
    };
    await q.enqueue(job);
    expect(add).toHaveBeenCalledWith('process_upload', job, {
      ...MEDIA_JOB_OPTIONS,
      jobId: `upload_${ORG}_${SUB}`,
    });
    expect(mediaProcessingJobId({ ...job, kind: 'process_recording_session' })).toBe(
      `session_${ORG}_${SUB}`,
    );
    expect(mediaProcessingJobId(job)).not.toContain(':');
  });
});

describe('#302 M-1 requeue + reconciler', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const SUB = '22222222-2222-4222-8222-222222222222';
  const job = {
    kind: 'process_recording_session' as const,
    organizationId: ORG,
    subjectType: 'recording_session' as const,
    subjectId: SUB,
    consentAttestationId: SUB,
  };
  it('requeue removes only a finished job with the same id, then adds it again', async () => {
    const add = vi.fn(async () => undefined);
    const removeIfFinished = vi.fn(async () => true);
    const q = new BullMqMediaJobQueue({ add, removeIfFinished });
    await q.requeue(job);
    expect(removeIfFinished).toHaveBeenCalledWith(`session_${ORG}_${SUB}`);
    expect(add).toHaveBeenCalledWith(
      'process_recording_session',
      job,
      expect.objectContaining({ jobId: `session_${ORG}_${SUB}` }),
    );
  });

  it('reconciler re-enqueues stale uploads with a valid consent and skips the rest', async () => {
    const jobs = new InMemoryMediaJobQueue();
    const consents = new InMemoryConsentRepository();
    const ok = await consents.record({
      organizationId: ORG,
      subjectType: 'upload',
      subjectId: SUB,
      consentVersion: CURRENT_CONSENT_VERSION,
      method: 'all_parties_consented',
      attestedByUserId: SUB,
      attestedAt: new Date(),
      recordedAt: new Date(),
    });
    const NOCONSENT = '33333333-3333-4333-8333-333333333333';
    const store = {
      organizationIds: async () => [ORG],
      staleUploads: vi.fn(async () => [
        { id: SUB, meetingId: null },
        { id: NOCONSENT, meetingId: null },
      ]),
    };
    const now = new Date('2026-10-28T12:00:00Z');
    const r = await reconcileStaleMedia({
      store,
      consents,
      jobs,
      now: () => now,
      olderThanMs: 60_000,
    });
    expect(r).toEqual({ organizations: 1, uploads: 1, skipped: 1 });
    expect(store.staleUploads).toHaveBeenCalledWith(ORG, new Date(now.getTime() - 60_000), 500);
    expect(jobs.jobs).toEqual([
      {
        kind: 'process_upload',
        organizationId: ORG,
        subjectType: 'upload',
        subjectId: SUB,
        consentAttestationId: ok.id,
      },
    ]);
    await reconcileStaleMedia({ store, consents, jobs, now: () => now, olderThanMs: 60_000 });
    expect(jobs.jobs).toHaveLength(1);
  });
});
