/**
 * Live (#303): chunk assembly against a REAL MinIO. Dummy bytes only. Chunks are PUT through the API's real
 * S3UploadSourceSigner, read through the real S3SessionChunkStore, assembled into the canonical source with the real
 * S3StorageService, SHA-256 verified, and the chunks deleted. The DB store is in memory (the Prisma store is covered
 * by the media-pipeline e2e). Skips unless STORAGE_IT_* point at a reachable MinIO.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts';
import {
  loadStorageConfig,
  S3SessionChunkStore,
  S3StorageService,
  S3UploadSourceSigner,
  StorageNotFoundError,
} from '@meetops/storage';
import {
  buildSessionAssemblyDeps,
  processSessionAssembly,
  workerAuthorize,
  type AssemblySession,
  type SessionAssemblyStore,
} from '../src/media/index.js';

const env = process.env;
const configured = Boolean(
  env.STORAGE_IT_ENDPOINT &&
  env.STORAGE_IT_BUCKET &&
  env.STORAGE_IT_ACCESS_KEY_ID &&
  env.STORAGE_IT_SECRET_ACCESS_KEY,
);
async function minioUp(): Promise<boolean> {
  if (!configured) return false;
  try {
    const r = await fetch(new URL('/minio/health/live', env.STORAGE_IT_ENDPOINT), {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
const available = await minioUp();
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!available)('session assembly with real MinIO (live)', () => {
  it('assembles real chunks into the source, verifies the SHA-256 and deletes the chunks', async () => {
    const config = loadStorageConfig({
      STORAGE_PROVIDER: 'minio',
      STORAGE_BUCKET: env.STORAGE_IT_BUCKET,
      STORAGE_ENDPOINT: env.STORAGE_IT_ENDPOINT,
      STORAGE_ACCESS_KEY_ID: env.STORAGE_IT_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: env.STORAGE_IT_SECRET_ACCESS_KEY,
      STORAGE_REGION: env.STORAGE_IT_REGION ?? 'us-east-1',
      STORAGE_FORCE_PATH_STYLE: 'true',
    });
    const [org, meeting, sid, rec, file, consent] = Array.from({ length: 6 }, () => randomUUID());
    const signer = new S3UploadSourceSigner({ config, now: () => new Date() });
    const parts = [
      Buffer.from('dummy-chunk-0'.padEnd(700, 'a')),
      Buffer.from('dummy-chunk-1'.padEnd(300, 'b')),
    ];
    const chunks = [];
    for (const [seq, b] of parts.entries()) {
      const key = `organizations/${org}/recording-sessions/${sid}/chunks/${String(seq).padStart(5, '0')}`;
      const put = await signer.presignPut({
        key,
        mimeType: 'video/webm',
        sizeBytes: b.length,
        checksumSha256Base64: createHash('sha256').update(b).digest('base64'),
        ttlSeconds: 60,
      });
      const res = await fetch(put.url, {
        method: 'PUT',
        headers: Object.fromEntries(
          Object.entries(put.headers).filter(([k]) => k !== 'content-length'),
        ),
        body: b,
      });
      expect(res.status).toBe(200);
      chunks.push({ seq, sizeBytes: b.length, sha256Hex: hex(b), key });
    }
    const whole = Buffer.concat(parts);
    const session: AssemblySession = {
      id: sid!,
      organizationId: org!,
      meetingId: meeting!,
      status: 'completed',
      chunkCount: parts.length,
      totalBytes: whole.length,
      mimeType: 'video/webm',
      recordingId: rec!,
      file: {
        id: file!,
        key: `organizations/${org}/meetings/${meeting}/recordings/${rec}.webm`,
        status: 'pending_upload',
        checksumSha256Hex: null,
        scanStatus: 'pending',
      },
      chunks,
      deleted: null,
      consent: {
        id: consent!,
        consentVersion: CURRENT_CONSENT_VERSION,
        attestedAt: new Date(),
        recordedAt: new Date(),
      },
    };
    const assembled: { sizeBytes: number; sha256Hex: string }[] = [];
    const store: SessionAssemblyStore = {
      load: async () => structuredClone(session),
      markAssembled: async (_o, a) => {
        assembled.push({ sizeBytes: a.sizeBytes, sha256Hex: a.sha256Hex });
        session.file!.status = 'uploaded';
      },
      markFailed: async () => {
        session.status = 'failed';
      },
      setScanStatus: async (_o, _f, v) => {
        session.file!.scanStatus = v;
      },
    };
    const storage = new S3StorageService({ config, authorize: workerAuthorize });
    const chunkStore = new S3SessionChunkStore({ config });
    const deps = buildSessionAssemblyDeps({
      storage,
      chunks: chunkStore,
      store,
      maxSourceBytes: 10 * 1024 * 1024,
      maxDurationSeconds: 60,
      env: {},
      process: () => Promise.reject(new Error('dummy media never reaches processing')),
    });
    const out = await processSessionAssembly(
      {
        kind: 'process_recording_session',
        organizationId: org,
        subjectType: 'recording_session',
        subjectId: sid,
        consentAttestationId: consent,
        meetingId: meeting,
      },
      deps,
    );
    // Dummy bytes are not media: assembled + verified, then the content scan quarantines them.
    expect(out).toEqual({ status: 'quarantined', sizeBytes: whole.length, sha256Hex: hex(whole) });
    expect(assembled).toEqual([{ sizeBytes: whole.length, sha256Hex: hex(whole) }]);
    for (const c of chunks) {
      await expect(chunkStore.readChunk(org!, sid!, c.key)).rejects.toBeInstanceOf(
        StorageNotFoundError,
      );
    }
    // Clean up the dummy source (no orphan objects in the throwaway bucket).
    const o = deps.objects({ ...session, recordingId: rec!, file: session.file! });
    await o.deleteSource();
  });
});
