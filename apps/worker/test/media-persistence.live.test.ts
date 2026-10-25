/**
 * Live: startMediaWorker's persistence wiring (#92) against real Postgres as meetops_app (NOBYPASSRLS) under forced
 * RLS. Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL are set (see packages/database/docs/ci-live-db.md).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, withOrganizationContext } from '@meetops/database';
import {
  chunkFileObjectId,
  createMediaPersistence,
  processRecording,
  type MediaJobPayload,
} from '../src/media/index.js';
import { makeWorkerParts } from './media-worker-harness.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('media worker chunk persistence (live, forced RLS)', () => {
  const app = createPrismaClient({ databaseUrl: APP_URL ?? '' });
  const owner = createPrismaClient({ databaseUrl: OWNER_URL ?? '' });
  const persistence = createMediaPersistence({
    client: app,
    bucket: 'meetops-live',
    provider: 'minio',
  });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const scope = new Map<string, { meetingId: string; recordingId: string }>();
  const root = mkdtempSync(path.join(tmpdir(), 'worker-live-'));
  const job = (organizationId: string, s = scope.get(organizationId)!): MediaJobPayload => ({
    jobVersion: 1,
    kind: 'process_recording',
    organizationId,
    meetingId: s.meetingId,
    recordingId: s.recordingId,
    sourceExt: 'webm',
  });
  const asOwner = <T>(org: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) =>
    withOrganizationContext(org, fn, { client: owner });

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'W A', slug: `w-a-${orgA}` },
        { id: orgB, name: 'W B', slug: `w-b-${orgB}` },
      ],
    });
    for (const organizationId of [orgA, orgB]) {
      scope.set(
        organizationId,
        await asOwner(organizationId, async (tx) => {
          const meeting = await tx.meeting.create({ data: { organizationId, title: 'w' } });
          const file = await tx.fileObject.create({
            data: {
              organizationId,
              meetingId: meeting.id,
              bucket: 'b',
              key: `organizations/${organizationId}/meetings/${meeting.id}/recordings/r.webm`,
              mimeType: 'audio/webm',
            },
          });
          const rec = await tx.recording.create({
            data: { organizationId, meetingId: meeting.id, fileObjectId: file.id },
          });
          return { meetingId: meeting.id, recordingId: rec.id };
        }),
      );
    }
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('writes chunk records and sets chunk_count for the job organization', async () => {
    const { recordingId, meetingId } = scope.get(orgA)!;
    const { deps, jobs } = makeWorkerParts(
      mkdtempSync(path.join(root, 'a-')),
      persistence,
      job(orgA),
    );
    await processRecording(job(orgA), deps);
    await processRecording(job(orgA), deps); // retry is idempotent
    const rows = await asOwner(orgA, (tx) =>
      tx.fileObject.findMany({
        where: { kind: 'chunk', meetingId },
        orderBy: { chunkIndex: 'asc' },
      }),
    );
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2].map((i) => chunkFileObjectId(recordingId, i)));
    for (const r of rows) {
      expect(r).toMatchObject({
        organizationId: orgA,
        status: 'uploaded',
        bucket: 'meetops-live',
        provider: 'minio',
        mimeType: 'audio/wav',
      });
      expect(r.key).toBe(
        `organizations/${orgA}/meetings/${meetingId}/processed/${recordingId}/chunks/0000${r.chunkIndex}.wav`,
      );
      expect(r.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const rec = await asOwner(orgA, (tx) =>
      tx.recording.findUniqueOrThrow({ where: { id: recordingId } }),
    );
    expect(rec.chunkCount).toBe(3);
    expect(jobs.size).toBe(3);
  });

  it('rows are invisible without an organization context and to another organization', async () => {
    const ids = [0, 1, 2].map((i) => chunkFileObjectId(scope.get(orgA)!.recordingId, i));
    expect(await app.fileObject.count({ where: { id: { in: ids } } })).toBe(0);
    expect(
      await withOrganizationContext(
        orgB,
        (tx) => tx.fileObject.count({ where: { id: { in: ids } } }),
        { client: app },
      ),
    ).toBe(0);
    expect(
      await persistence.chunkLookup.findFileObject({ organizationId: orgB, fileObjectId: ids[0]! }),
    ).toBeNull();
    expect(
      await persistence.chunkLookup.findFileObject({ organizationId: orgA, fileObjectId: ids[0]! }),
    ).toMatchObject({ organizationId: orgA, kind: 'chunk' });
  });

  it("a job claiming organization B for A's recording writes nothing to A and enqueues nothing", async () => {
    const a = scope.get(orgA)!;
    const b = scope.get(orgB)!;
    const before = await asOwner(orgA, (tx) => tx.fileObject.count());
    const forged = job(orgB, a);
    const { deps, jobs } = makeWorkerParts(mkdtempSync(path.join(root, 'b-')), persistence, forged);
    await expect(processRecording(forged, deps)).rejects.toMatchObject({
      errorCode: expect.stringMatching(/_persist_failed$/),
    });
    expect(jobs.size).toBe(0);
    expect(await asOwner(orgA, (tx) => tx.fileObject.count())).toBe(before);
    const recA = await asOwner(orgA, (tx) =>
      tx.recording.findUniqueOrThrow({ where: { id: a.recordingId } }),
    );
    expect(recA.chunkCount).toBe(3); // untouched by the forged job
    const recB = await asOwner(orgB, (tx) =>
      tx.recording.findUniqueOrThrow({ where: { id: b.recordingId } }),
    );
    expect(recB.chunkCount).toBeNull();
  });
});
