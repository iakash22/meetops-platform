/**
 * Live end to end with MEDIA_STORAGE_ENABLED-style adapters (dummy media only): API init -> complete over Prisma
 * (file_objects, consent_attestations, recording_sessions) -> durable BullMQ job on MEDIA_QUEUE -> the worker's
 * dispatchMediaJob + processUploadScan with its Prisma scan store. The object store is a fake signer/source holding
 * a few synthetic bytes, so the scan quarantines them (not media) and download stays 404.
 * Skips unless TEST_DATABASE_URL (meetops_app) and TEST_REDIS_URL are set. Per-run emails (#302 L-2): can share a database
 * with the other live suites.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { MEDIA_QUEUE } from '@meetops/contracts';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
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
    h: { recording(): Promise<never>; upload(d: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown> },
  ): Promise<{ status: string; reason?: string }>;
  processUploadScan(d: unknown, deps: unknown, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
  buildUploadScanDeps(p: Record<string, unknown>): unknown;
  createUploadScanStore(o: { client: DatabaseClient }): unknown;
}
const workerPath = new URL('../../worker/src/media/index.ts', import.meta.url).href;

describe.skipIf(!url || !redisUrl)('media pipeline e2e (Prisma + BullMQ + worker, live)', () => {
  const prefix = `it-media-${randomBytes(4).toString('hex')}`;
  const connection = { url: redisUrl!, maxRetriesPerRequest: null };
  const DUMMY = Buffer.from('not-media-dummy-bytes'.padEnd(1000, '.'));
  const signer = new FakeMediaSigner();
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
    w = await mediaWorld({ db, media }, randomUUID().slice(0, 8));
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
    worker = new Worker(
      MEDIA_QUEUE,
      (job) =>
        wm.dispatchMediaJob(job, {
          recording: () => Promise.reject(new Error('unexpected recording job')),
          upload: (d, ctx) => wm.processUploadScan(d, deps, ctx),
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

  it('recording session: Prisma chunks + completion create the recording; job is durable and acknowledged', async () => {
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
    const sha = 'a'.repeat(64);
    const c = await w.member.post(`/recording-sessions/${sid}/chunks`, { seq: 0, sizeBytes: 1000, sha256: sha });
    expect(c.statusCode).toBe(200);
    const row = await media.sessions.findById(w.org, sid);
    expect(row?.totalBytes).toBe(1000);
    signer.put(row!.chunks.get(0)!.key, 1000);
    const done = await w.member.post(`/recording-sessions/${sid}/complete`, { chunkCount: 1, durationMs: 1000 });
    expect(done.statusCode).toBe(202);
    expect((await media.sessions.findById(w.org, sid))?.status).toBe('completed');
    expect(await media.sessions.findById(w.otherOrg, sid)).toBeNull();

    const job = await queue.getJob(`session_${w.org}_${sid}`);
    expect(job?.data).toMatchObject({ kind: 'process_recording_session', subjectId: sid, meetingId });
    const out = (await job!.waitUntilFinished(events, 30_000)) as { reason: string };
    expect(out.reason).toBe('session_assembly_pending');
  });
});
