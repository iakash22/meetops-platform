/**
 * MinIO / S3-compatible integration test. Skipped unless all of these are set (DevOps wires MinIO into CI):
 *   STORAGE_IT_ENDPOINT, STORAGE_IT_BUCKET, STORAGE_IT_ACCESS_KEY_ID, STORAGE_IT_SECRET_ACCESS_KEY
 * No credentials live in this file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { S3StorageService, loadStorageConfig, type MeetingObjectRef } from '../src/index.js';

const env = process.env;
const enabled = Boolean(env.STORAGE_IT_ENDPOINT && env.STORAGE_IT_BUCKET && env.STORAGE_IT_ACCESS_KEY_ID && env.STORAGE_IT_SECRET_ACCESS_KEY);

describe.skipIf(!enabled)('S3StorageService against MinIO', () => {
  const svc = () =>
    new S3StorageService({
      config: loadStorageConfig({
        STORAGE_ENDPOINT: env.STORAGE_IT_ENDPOINT,
        STORAGE_BUCKET: env.STORAGE_IT_BUCKET,
        STORAGE_ACCESS_KEY_ID: env.STORAGE_IT_ACCESS_KEY_ID,
        STORAGE_SECRET_ACCESS_KEY: env.STORAGE_IT_SECRET_ACCESS_KEY,
        STORAGE_FORCE_PATH_STYLE: 'true'
      }),
      authorize: () => undefined
    });

  it('presigned PUT -> verifyUpload returns verified:true and is idempotent; delete cleans up', async () => {
    const s = svc();
    const data = Buffer.from(`meetops-it-${randomUUID()}`);
    const checksumSha256 = createHash('sha256').update(data).digest('base64');
    const ref: MeetingObjectRef = { organizationId: 'it-org', meetingId: 'it-meeting', kind: 'recording', objectId: randomUUID(), ext: 'webm' };
    const p = await s.getPresignedUploadUrl(ref, { mimeType: 'audio/webm', sizeBytes: data.byteLength, checksumSha256 });
    const put = await fetch(p.url, { method: 'PUT', headers: p.headers, body: data });
    expect(put.ok).toBe(true);
    const v = await s.verifyUpload(ref, p.uploadToken);
    expect(v).toMatchObject({ verified: true, checksumSha256: Buffer.from(checksumSha256, 'base64').toString('hex'), checksumSha256Base64: checksumSha256, sizeBytes: data.byteLength });
    await expect(s.verifyUpload(ref, p.uploadToken)).resolves.toEqual(v);
    await s.deleteObject(ref);
    expect(await s.headObject(ref)).toBeNull();
  });
});
