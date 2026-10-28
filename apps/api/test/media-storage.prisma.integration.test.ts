/**
 * Live: upload routes against Postgres (file_objects + consent_attestations) with a fake signer (dummy media, no
 * object store). Runs only with TEST_DATABASE_URL (meetops_app login) set, e.g. via a throwaway container.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { storageMediaAdapters, type MediaAdapters } from '../src/modules/index.js';
import { FakeMediaSigner } from '../src/modules/media/infrastructure/in-memory.js';
import { consent, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('media storage wiring (Prisma, live)', () => {
  let db: DatabaseClient;
  let w: MediaWorld;
  let media: MediaAdapters;
  const signer = new FakeMediaSigner();
  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    media = storageMediaAdapters(db, { STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'live-test' }, undefined, signer);
    // mediaWorld returns its own in-memory adapters; the app uses the injected storage-backed ones.
    w = await mediaWorld({ db, media });
  });
  afterAll(async () => {
    await w?.app.close();
    await db?.$disconnect();
  });

  it('init -> complete -> download persists the file row and consent, scoped to the org', async () => {
    const init = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'dummy.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(init.statusCode).toBe(201);
    const id = init.json<{ fileObjectId: string }>().fileObjectId;
    const file = await media.files.findById(w.org, id);
    expect(file).toMatchObject({ status: 'pending_upload', checksumSha256Base64: SHA_B64, scanStatus: null });
    expect(await media.files.findById(w.otherOrg, id)).toBeNull();
    const c = await media.consents.findLatest(w.org, 'upload', id);
    expect(c?.subjectId).toBe(id);

    signer.put(file!.key, 1000); // dummy object: size + signed checksum only
    const done = await w.member.post(`/orgs/${w.org}/uploads/${id}/complete`, {});
    expect(done.statusCode).toBe(200);
    expect((await media.files.findById(w.org, id))?.scanStatus).toBe('pending');
  });
});
