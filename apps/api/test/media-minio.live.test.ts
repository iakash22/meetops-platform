/**
 * #300: live upload flow with the REAL S3UploadSourceSigner against MinIO + Postgres. Runs only when
 * TEST_DATABASE_URL and STORAGE_IT_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY are set (throwaway local
 * values from the test environment; none live in this file), and skips when MinIO is not reachable.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { S3UploadSourceSigner } from '@meetops/storage';
import { storageMediaAdapters, type MediaAdapters } from '../src/modules/index.js';
import { consent, mediaWorld, type MediaWorld } from './media-helpers.js';

const env = process.env;
const url = env.TEST_DATABASE_URL;
const configured = Boolean(
  url &&
  env.STORAGE_IT_ENDPOINT &&
  env.STORAGE_IT_BUCKET &&
  env.STORAGE_IT_ACCESS_KEY_ID &&
  env.STORAGE_IT_SECRET_ACCESS_KEY,
);

async function minioUp(): Promise<boolean> {
  try {
    const r = await fetch(new URL('/minio/health/live', env.STORAGE_IT_ENDPOINT), {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
const available = configured && (await minioUp());

describe.skipIf(!available)('upload flow with the real S3 signer (MinIO, live)', () => {
  let db: DatabaseClient;
  let w: MediaWorld;
  let media: MediaAdapters;
  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    media = storageMediaAdapters(db, {
      STORAGE_PROVIDER: 'minio',
      STORAGE_ENDPOINT: env.STORAGE_IT_ENDPOINT,
      STORAGE_BUCKET: env.STORAGE_IT_BUCKET,
      STORAGE_ACCESS_KEY_ID: env.STORAGE_IT_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: env.STORAGE_IT_SECRET_ACCESS_KEY,
      STORAGE_FORCE_PATH_STYLE: 'true',
    });
    w = await mediaWorld({ db, media });
  });
  afterAll(async () => {
    await w?.app.close();
    await db?.$disconnect();
  });

  it('init (201, 300 s URL) -> PUT to MinIO -> complete (200); replay 409; other org 404', async () => {
    expect(media.signer).toBeInstanceOf(S3UploadSourceSigner);
    const data = Buffer.from(`meetops-live-${Date.now()}`);
    const sha = createHash('sha256').update(data).digest('base64');
    const init = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'live.webm',
      mimeType: 'audio/webm',
      sizeBytes: data.byteLength,
      checksumSha256: sha,
      consent: consent(),
    });
    expect(init.statusCode).toBe(201);
    const { fileObjectId, upload } = init.json<{
      fileObjectId: string;
      upload: { url: string; headers: Record<string, string> };
    }>();
    expect(new URL(upload.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(await media.consents.findLatest(w.org, 'upload', fileObjectId)).not.toBeNull();

    // fetch derives content-length from the body (undici rejects it as an explicit header); the signed value matches.
    expect(upload.headers['content-length']).toBe(String(data.byteLength));
    const headers = Object.fromEntries(
      Object.entries(upload.headers).filter(([k]) => k !== 'content-length'),
    );
    const put = await fetch(upload.url, { method: 'PUT', headers, body: data });
    expect(put.status).toBe(200);

    expect(
      (await w.other.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {})).statusCode,
    ).toBe(404);
    const done = await w.member.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {});
    expect(done.statusCode).toBe(200);
    expect(
      (await w.member.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {})).statusCode,
    ).toBe(409);
    expect((await media.files.findById(w.org, fileObjectId))?.status).toBe('processing');
  });
});
