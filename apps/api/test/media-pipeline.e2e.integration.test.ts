/**
 * Live end to end with MEDIA_STORAGE_ENABLED-style adapters (dummy media only): API init -> complete over Prisma
 * (file_objects, consent_attestations, recording_sessions) -> durable BullMQ job on MEDIA_QUEUE -> the worker's
 * dispatchMediaJob + processUploadScan / processSessionAssembly with their Prisma stores. The object store is a fake signer/source holding
 * a few synthetic bytes, so the scan quarantines them (not media) and download stays 404.
 * Skips unless TEST_DATABASE_URL (meetops_app) and TEST_REDIS_URL are set. Uses fixed mediaWorld emails: run it
 * against a fresh database (not in the same run as media-storage.prisma.integration.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { MEDIA_QUEUE } from '@meetops/contracts';
import { buildObjectKey, StorageNotFoundError, type MeetingObjectRef } from '@meetops/storage';
import { createPrismaClient, withOrganizationContext, type DatabaseClient } from '@meetops/database';
import { storageMediaAdapters, type MediaAdapters } from '../src/modules/index.js';
import { BullMqMediaJobQueue } from '../src/modules/media/infrastructure/bullmq.js';
import { FakeMediaSigner } from '../src/modules/media/infrastructure/in-memory.js';
import type { MediaProcessingJob } from '../src/modules/media/domain/ports.js';
import { consent, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

/** The slice of apps/worker/src/media the test drives (loaded by path: apps do not depend on each other). */
interface WorkerMedia {
  dispatchMediaJob(
    job: Pick<Job, 'id' | 'attemptsMade' | 'opts'> & { data: unknown },
    h: {
      recording(): Promise<never>;
      upload(d: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
      session(d: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
    },
  ): Promise<{ status: string; reason?: string }>;
  processUploadScan(d: unknown, deps: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
  processSessionAssembly(d: unknown, deps: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
  buildSessionAssemblyDeps(p: Record<string, unknown>): unknown;
  createSessionAssemblyStore(o: { client: DatabaseClient }): unknown;
  buildUploadScanDeps(p: Record<string, unknown>): unknown;
  createUploadScanStore(o: { client: DatabaseClient }): unknown;
}
const workerPath = new URL('../../worker/src/media/index.ts', import.meta.url).href;

describe.skipIf(!url || !redisUrl)('media pipeline e2e (Prisma + BullMQ + worker, live)', () => {
  const prefix = `it-media-${randomBytes(4).toString('hex')}`;
  const connection = { url: redisUrl!, maxRetriesPerRequest: null };
  const DUMMY = Buffer.from('not-media-dummy-bytes'.padEnd(1000, '.'));
  const signer = new FakeMediaSigner();
  const blobs = new Map<string, Buffer>();
  const CHUNK = Buffer.from('dummy-session-chunk'.padEnd(1000, '#'));
  const CHUNK_SHA = createHash('sha256').update(CHUNK).digest('hex');
  let db: DatabaseClient;
  let queue: Queue<MediaProcessingJob>;
  let events: QueueEvents;
  let worker: Worker;
  let media: MediaAdapters;
  let w: MediaWorld;

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    queue = new Queue<MediaProcessingJob>(MEDIA_QUEUE, { connection, prefix });
    events = new QueueEvents(MEDIA_QUEUE, { connection, prefix });
    await events.waitUntilReady();
    media = storageMediaAdapters(
      db,
      { STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'live-test' },
      undefined,
      { signer, jobs: new BullMqMediaJobQueue({ add: (n, d, o) => queue.add(n, d, o) }) },
    );
    w = await mediaWorld({ db, media });
    const wm = (await import(workerPath)) as WorkerMedia;
    const storage = {
      headUploadSource: async () => ({ sizeBytes: DUMMY.length }),
      getUploadSource: async () => ({ body: Readable.from([DUMMY]), info: { sizeBytes: DUMMY.length } }),
    };
    const deps = wm.buildUploadScanDeps({
      storage,
      emitter: { to: () => ({ emit: () => undefined }) },
      maxDurationSeconds: 60,
      env: {},
      store: wm.createUploadScanStore({ client: db }),
    });
    // Fake object store for the session path (dummy bytes in memory); real Prisma store + real content scan.
    const sessionDeps = wm.buildSessionAssemblyDeps({
      storage: {
        putObject: async (ref: MeetingObjectRef, body: Readable) => {
          const got: Buffer[] = [];
          for await (const p of body) got.push(Buffer.from(p as Buffer));
          blobs.set(buildObjectKey(ref), Buffer.concat(got));
          return {};
        },
        headObject: async (ref: MeetingObjectRef) => {
          const b = blobs.get(buildObjectKey(ref));
          return b ? { sizeBytes: b.length } : null;
        },
        deleteObject: async (ref: MeetingObjectRef) => {
          blobs.delete(buildObjectKey(ref));
        },
        getObject: async (ref: MeetingObjectRef) => {
          const b = blobs.get(buildObjectKey(ref))!;
          return { body: Readable.from([b]), info: { sizeBytes: b.length } };
        },
      },
      chunks: {
        readChunk: async (_o: string, _s: string, key: string) => {
          const b = blobs.get(key);
          if (!b) throw new StorageNotFoundError();
          return Readable.from([b]);
        },
        deleteChunk: async (_o: string, _s: string, key: string) => {
          blobs.delete(key);
        },
      },
      store: wm.createSessionAssemblyStore({ client: db }),
      maxSourceBytes: 10 * 1024 * 1024,
      maxDurationSeconds: 60,
      env: {},
      process: () => Promise.reject(new Error('dummy media never reaches processing')),
    });
    worker = new Worker(
      MEDIA_QUEUE,
      (job) =>
        wm.dispatchMediaJob(job, {
          recording: () => Promise.reject(new Error('unexpected recording job')),
          upload: (d, ctx) => wm.processUploadScan(d, deps, ctx),
          session: (d, ctx) => wm.processSessionAssembly(d, sessionDeps, ctx),
        }),
      { connection, prefix },
    );
  });
  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await Promise.allSettled([queue?.close(), events?.close()]);
    await w?.app.close();
    await db?.$disconnect();
  });

  it('upload: init -> complete enqueues one durable job; the worker scans it and records the verdict', async () => {
    const init = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'dummy.webm',
      mimeType: 'audio/webm',
      sizeBytes: DUMMY.length,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(init.statusCode).toBe(201);
    const id = init.json<{ fileObjectId: string }>().fileObjectId;
    const key = (await media.files.findById(w.org, id))!.key;
    signer.put(key, DUMMY.length);
    const done = await w.member.post(`/orgs/${w.org}/uploads/${id}/complete`, {});
    expect(done.statusCode).toBe(200);

    const job = await queue.getJob(`upload_${w.org}_${id}`);
    expect(job?.data).toMatchObject({ kind: 'process_upload', organizationId: w.org, subjectId: id });
    const out = (await job!.waitUntilFinished(events, 30_000)) as { status: string };
    expect(out.status).toBe('quarantined');
    expect((await media.files.findById(w.org, id))?.scanStatus).toBe('quarantined');
    const dl = await w.member.get(`/orgs/${w.org}/uploads/${id}/download-url`);
    expect(dl.statusCode).toBe(404);
  });

  it('recording session: chunks -> complete -> durable job -> worker assembles, verifies and scans', async () => {
    const meetingId = (
      await w.member.post(`/orgs/${w.org}/meetings/resolve`, {
        source: 'extension',
        externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
        title: 'Dummy',
      })
    ).json<{ meetingId: string }>().meetingId;
    const s = await w.member.post(`/orgs/${w.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId,
      consent: consent(),
    });
    expect(s.statusCode).toBe(201);
    const sid = s.json<{ sessionId: string }>().sessionId;
    const c = await w.member.post(`/recording-sessions/${sid}/chunks`, {
      seq: 0,
      sizeBytes: CHUNK.length,
      sha256: CHUNK_SHA,
    });
    expect(c.statusCode).toBe(200);
    const row = await media.sessions.findById(w.org, sid);
    expect(row?.totalBytes).toBe(1000);
    const chunkKey = row!.chunks.get(0)!.key;
    signer.put(chunkKey, CHUNK.length);
    blobs.set(chunkKey, CHUNK);
    const done = await w.member.post(`/recording-sessions/${sid}/complete`, { chunkCount: 1, durationMs: 1000 });
    expect(done.statusCode).toBe(202);
    expect((await media.sessions.findById(w.org, sid))?.status).toBe('completed');
    expect(await media.sessions.findById(w.otherOrg, sid)).toBeNull();

    const job = await queue.getJob(`session_${w.org}_${sid}`);
    expect(job?.data).toMatchObject({ kind: 'process_recording_session', subjectId: sid, meetingId });
    const out = (await job!.waitUntilFinished(events, 30_000)) as {
      status: string;
      sizeBytes: number;
      sha256Hex: string;
    };
    // Dummy bytes are not media: assembled + verified, then the content scan quarantines them.
    expect(out).toEqual({ status: 'quarantined', sizeBytes: CHUNK.length, sha256Hex: CHUNK_SHA });
    expect(blobs.has(chunkKey)).toBe(false);
    const rows = await withOrganizationContext(
      w.org,
      (tx) =>
        tx.recordingSession.findFirst({
          where: { id: sid },
          select: {
            status: true,
            recording: {
              select: {
                status: true,
                file: { select: { status: true, scanStatus: true, checksumSha256: true, sizeBytes: true, key: true } },
              },
            },
          },
        }),
      { client: db },
    );
    expect(rows).toMatchObject({
      status: 'completed',
      recording: {
        status: 'uploaded',
        file: { status: 'uploaded', scanStatus: 'quarantined', checksumSha256: CHUNK_SHA, sizeBytes: BigInt(CHUNK.length) },
      },
    });
    expect(blobs.get(rows!.recording!.file.key)).toEqual(CHUNK);
  });
});
