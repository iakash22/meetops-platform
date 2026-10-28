/**
 * Live: upload routes against Postgres (file_objects + consent_attestations) with a fake signer (dummy media, no
 * object store). Runs only with TEST_DATABASE_URL (meetops_app login) set, e.g. via a throwaway container.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { storageMediaAdapters, type MediaAdapters } from '../src/modules/index.js';
import {
  FakeMediaSigner,
  InMemoryMediaJobQueue,
} from '../src/modules/media/infrastructure/in-memory.js';
import { reconcileStaleMedia } from '../src/modules/media/application/reconcile.js';
import { PrismaStaleMediaStore } from '../src/modules/media/infrastructure/prisma.js';
import { consent, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';
import { signupAndLogin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('media storage wiring (Prisma, live)', () => {
  let db: DatabaseClient;
  let w: MediaWorld;
  let media: MediaAdapters;
  const signer = new FakeMediaSigner();
  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    media = storageMediaAdapters(
      db,
      { STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'live-test' },
      undefined,
      { signer, jobs: new InMemoryMediaJobQueue() },
    );
    // mediaWorld returns its own in-memory adapters; the app uses the injected storage-backed ones.
    w = await mediaWorld({ db, media }, randomUUID().slice(0, 8));
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
    expect(file).toMatchObject({
      status: 'pending_upload',
      checksumSha256Base64: SHA_B64,
      scanStatus: null,
    });
    expect(await media.files.findById(w.otherOrg, id)).toBeNull();
    const c = await media.consents.findLatest(w.org, 'upload', id);
    expect(c?.subjectId).toBe(id);

    signer.put(file!.key, 1000); // dummy object: size + signed checksum only
    const done = await w.member.post(`/orgs/${w.org}/uploads/${id}/complete`, {});
    expect(done.statusCode).toBe(200);
    expect((await media.files.findById(w.org, id))?.scanStatus).toBe('pending');
  });

  const counts = (org: string) =>
    withOrganizationContext(
      org,
      async (tx) => ({
        files: await tx.fileObject.count({ where: { organizationId: org } }),
        consents: await tx.consentAttestation.count({ where: { organizationId: org } }),
      }),
      { client: db },
    );

  it('#300 M-1: a signer failure leaves no file row and no consent attestation', async () => {
    const before = await counts(w.org);
    const spy = vi.spyOn(signer, 'presignPut').mockRejectedValueOnce(new RangeError('ttl'));
    const r = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'dummy.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    spy.mockRestore();
    expect(r.statusCode).toBe(500);
    expect(await counts(w.org)).toEqual(before);
  });

  it('#300 L-1: createWithConsent is one transaction (a consent insert failure rolls back the file row)', async () => {
    const before = await counts(w.org);
    const ok = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'dummy.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(ok.statusCode).toBe(201);
    const tmpl = (await media.files.findById(
      w.org,
      ok.json<{ fileObjectId: string }>().fileObjectId,
    ))!;
    const id = randomUUID();
    const file = {
      ...tmpl,
      id,
      key: `organizations/${w.org}/uploads/${id}/source`,
      createdAt: new Date(),
    };
    const att = await media.consents.findLatest(w.org, 'upload', tmpl.id);
    // attestedByUserId has an FK to users: an unknown user makes the consent insert (second statement) fail.
    await expect(
      media.files.createWithConsent!(file, {
        organizationId: w.org,
        subjectType: 'upload',
        subjectId: id,
        consentVersion: att!.consentVersion,
        method: att!.method,
        attestedByUserId: randomUUID(),
        attestedAt: new Date(),
        recordedAt: new Date(),
      }),
    ).rejects.toThrow();
    expect(await media.files.findById(w.org, id)).toBeNull();
    const after = await counts(w.org);
    expect(after).toEqual({ files: before.files + 1, consents: before.consents + 1 });
  });

  it('#302 M-1: enqueue fails after the commit; the reconciler re-enqueues the stuck upload once', async () => {
    const init = await w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'dummy.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    const id = init.json<{ fileObjectId: string }>().fileObjectId;
    signer.put((await media.files.findById(w.org, id))!.key, 1000);
    const jobs = media.jobs as InMemoryMediaJobQueue;
    const spy = vi.spyOn(jobs, 'enqueue').mockRejectedValueOnce(new Error('redis down'));
    expect((await w.member.post(`/orgs/${w.org}/uploads/${id}/complete`, {})).statusCode).toBe(500);
    spy.mockRestore();
    expect(await media.files.findById(w.org, id)).toMatchObject({
      status: 'processing',
      scanStatus: 'pending',
    });
    const before = jobs.jobs.length;
    const run = () =>
      reconcileStaleMedia({
        store: new PrismaStaleMediaStore(db),
        consents: media.consents,
        jobs,
        now: () => new Date(Date.now() + 1000),
        olderThanMs: 0,
      });
    const r1 = await run();
    expect(r1.uploads).toBeGreaterThanOrEqual(1);
    expect(jobs.jobs.filter((j) => j.subjectId === id)).toHaveLength(1);
    await run(); // idempotent: same deterministic id, still one job
    expect(jobs.jobs.filter((j) => j.subjectId === id)).toHaveLength(1);
    expect(jobs.jobs.length).toBeGreaterThan(before);
  });

  it('#302 L-2b: concurrent org creates with the same name never 500 (unique slug -> 409)', async () => {
    const name = `Race ${randomUUID().slice(0, 8)}`;
    const tag = randomUUID().slice(0, 8);
    const users = await Promise.all(
      Array.from({ length: 4 }, (_, i) => signupAndLogin(w.app, `race${i}+${tag}@example.com`)),
    );
    const codes = await Promise.all(
      users.map(async (u) => (await u.post('/orgs', { name })).statusCode),
    );
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
    expect(codes).toContain(201);
  });
});
