/**
 * Live tests for the Media #92 ports: RecordingChunkCountRepository, ChunkFileObjectRepository and
 * ChunkFileObjectLookup, as meetops_app under forced RLS, including cross-organization denial.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import {
  MediaPersistenceError,
  createChunkFileObjectLookup,
  createChunkFileObjectRepository,
  createRecordingChunkCountRepository,
  createRecordingChunkPersistence,
  createRecordingOwnershipVerifier,
  type ChunkFileObjectRow,
} from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const HEX = (c: string) => c.repeat(64);

describe.skipIf(!APP_URL || !OWNER_URL)('media chunk persistence (live, PR #92 ports)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const counts = createRecordingChunkCountRepository({ client: app });
  const chunks = createChunkFileObjectRepository({ client: app, bucket: 'meetops-test' });
  const lookup = createChunkFileObjectLookup({ client: app });
  const verifier = createRecordingOwnershipVerifier({ client: app });
  const atomic = createRecordingChunkPersistence({ client: app, bucket: 'meetops-test' });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const scope = new Map<string, { meetingId: string; recordingId: string }>();

  const key = (prefix: string, org: string, i: number) => {
    const s = scope.get(org)!;
    return `${prefix}/${org}/meetings/${s.meetingId}/processed/${s.recordingId}/chunks/${String(i).padStart(5, '0')}.wav`;
  };
  const row = (
    org: string,
    i: number,
    over: Partial<ChunkFileObjectRow> = {},
  ): ChunkFileObjectRow => ({
    fileObjectId: randomUUID(),
    index: i,
    storageKey: key('organizations', org, i),
    sizeBytes: 1000 + i,
    mimeType: 'audio/wav',
    sha256: HEX('a'),
    startMs: i * 600_000,
    durationMs: 600_000,
    ...over,
  });

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'M A', slug: `m-a-${orgA}` },
        { id: orgB, name: 'M B', slug: `m-b-${orgB}` },
      ],
    });
    for (const organizationId of [orgA, orgB]) {
      const s = await runWithOrganizationContext(owner, organizationId, async (tx) => {
        const meeting = await tx.meeting.create({ data: { organizationId, title: 'm' } });
        const file = await tx.fileObject.create({
          data: {
            organizationId,
            meetingId: meeting.id,
            bucket: 'b',
            key: `org/${organizationId}/meetings/${meeting.id}/recordings/r.webm`,
            mimeType: 'audio/webm',
          },
        });
        const rec = await tx.recording.create({
          data: { organizationId, meetingId: meeting.id, fileObjectId: file.id },
        });
        return { meetingId: meeting.id, recordingId: rec.id };
      });
      scope.set(organizationId, s);
    }
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  describe('RecordingChunkCountRepository', () => {
    it('sets recordings.chunk_count', async () => {
      await counts.setChunkCount({ organizationId: orgA, ...scope.get(orgA)!, chunkCount: 3 });
      const r = await runWithOrganizationContext(owner, orgA, (tx) =>
        tx.recording.findUniqueOrThrow({ where: { id: scope.get(orgA)!.recordingId } }),
      );
      expect(r.chunkCount).toBe(3);
    });

    it('rejects out-of-range counts in code and in SQL (CHECK 1..10000)', async () => {
      for (const n of [0, 10001, 1.5]) {
        await expect(
          counts.setChunkCount({ organizationId: orgA, ...scope.get(orgA)!, chunkCount: n }),
        ).rejects.toBeInstanceOf(MediaPersistenceError);
      }
      await expect(
        runWithOrganizationContext(
          app,
          orgA,
          (tx) =>
            tx.$executeRaw`UPDATE "recordings" SET "chunk_count" = 0 WHERE "id" = ${scope.get(orgA)!.recordingId}::uuid`,
        ),
      ).rejects.toThrow(/recordings_chunk_count_check|23514/);
    });

    it('cross-organization: A cannot set B count, and a wrong meeting matches nothing', async () => {
      await expect(
        counts.setChunkCount({ organizationId: orgA, ...scope.get(orgB)!, chunkCount: 2 }),
      ).rejects.toMatchObject({ code: 'chunk_count_not_updated' });
      await expect(
        counts.setChunkCount({
          organizationId: orgA,
          meetingId: scope.get(orgB)!.meetingId,
          recordingId: scope.get(orgA)!.recordingId,
          chunkCount: 2,
        }),
      ).rejects.toMatchObject({ code: 'chunk_count_not_updated' });
      const b = await runWithOrganizationContext(owner, orgB, (tx) =>
        tx.recording.findUniqueOrThrow({ where: { id: scope.get(orgB)!.recordingId } }),
      );
      expect(b.chunkCount).toBeNull();
    });
  });

  describe('ChunkFileObjectRepository + ChunkFileObjectLookup', () => {
    const rowsA: ChunkFileObjectRow[] = [];

    it('upserts chunk rows idempotently; lookup returns the #92 record shape', async () => {
      const { sha256: _omit, ...noSha } = row(orgA, 2);
      void _omit;
      rowsA.push(row(orgA, 0), row(orgA, 1), noSha);
      const q = { organizationId: orgA, ...scope.get(orgA)!, chunks: rowsA };
      await chunks.upsertChunkFileObjects(q);
      await chunks.upsertChunkFileObjects(q); // retry: identical rows
      await chunks.upsertChunkFileObjects({
        ...q,
        chunks: [{ ...rowsA[0]!, sizeBytes: 4242, sha256: HEX('b') }],
      });
      const r = await lookup.findFileObject({
        organizationId: orgA,
        fileObjectId: rowsA[0]!.fileObjectId,
      });
      expect(r).toEqual({
        id: rowsA[0]!.fileObjectId,
        organizationId: orgA,
        meetingId: scope.get(orgA)!.meetingId,
        kind: 'chunk',
        key: rowsA[0]!.storageKey,
        mimeType: 'audio/wav',
        sizeBytes: 4242n,
        chunkIndex: 0,
      });
      const full = await runWithOrganizationContext(owner, orgA, (tx) =>
        tx.fileObject.findUniqueOrThrow({ where: { id: rowsA[1]!.fileObjectId } }),
      );
      expect(full).toMatchObject({
        status: 'uploaded',
        bucket: 'meetops-test',
        provider: 's3',
        startSeconds: 600,
        durationSeconds: 600,
        checksumSha256: HEX('a'),
      });
    });

    it('legacy org/ prefix is rejected for new chunk writes (ADR-010 phase A)', async () => {
      await expect(
        chunks.upsertChunkFileObjects({
          organizationId: orgA,
          ...scope.get(orgA)!,
          chunks: [row(orgA, 7, { storageKey: key('org', orgA, 7) })],
        }),
      ).rejects.toMatchObject({ code: 'invalid_chunk_row' });
    });

    it('throws (and writes nothing) if an existing id has a different key', async () => {
      const moved = { ...rowsA[1]!, storageKey: key('organizations', orgA, 9), index: 9 };
      const fresh = row(orgA, 8);
      await expect(
        chunks.upsertChunkFileObjects({
          organizationId: orgA,
          ...scope.get(orgA)!,
          chunks: [fresh, moved],
        }),
      ).rejects.toMatchObject({ code: 'chunk_file_object_conflict' });
      expect(
        await lookup.findFileObject({ organizationId: orgA, fileObjectId: fresh.fileObjectId }),
      ).toBeNull();
    });

    it('cross-organization: B cannot take over an A row id; A cannot look up or write B rows', async () => {
      const hijack = { ...rowsA[0]!, storageKey: key('organizations', orgB, 0) };
      await expect(
        chunks.upsertChunkFileObjects({
          organizationId: orgB,
          ...scope.get(orgB)!,
          chunks: [hijack],
        }),
      ).rejects.toThrow();
      const a0 = await lookup.findFileObject({
        organizationId: orgA,
        fileObjectId: rowsA[0]!.fileObjectId,
      });
      expect(a0?.organizationId).toBe(orgA);
      expect(
        await lookup.findFileObject({ organizationId: orgB, fileObjectId: rowsA[0]!.fileObjectId }),
      ).toBeNull();
      // A writing into B's meeting/recording key space is rejected before SQL (key/scope mismatch) ...
      await expect(
        chunks.upsertChunkFileObjects({
          organizationId: orgA,
          ...scope.get(orgB)!,
          chunks: [row(orgB, 0)],
        }),
      ).rejects.toMatchObject({ code: 'invalid_chunk_row' });
      // ... and an A-keyed row pointed at B's meeting fails the composite (org, meeting) FK.
      await expect(
        chunks.upsertChunkFileObjects({
          organizationId: orgA,
          meetingId: scope.get(orgB)!.meetingId,
          recordingId: scope.get(orgA)!.recordingId,
          chunks: [
            row(orgA, 3, {
              storageKey: `organizations/${orgA}/meetings/${scope.get(orgB)!.meetingId}/processed/${scope.get(orgA)!.recordingId}/chunks/00003.wav`,
            }),
          ],
        }),
      ).rejects.toThrow();
    });

    it('rejects malformed rows: non-hex/uppercase sha256, bad key, wrong index', async () => {
      const base = { organizationId: orgA, ...scope.get(orgA)! };
      for (const bad of [
        row(orgA, 4, { sha256: 'A'.repeat(64) }),
        row(orgA, 4, { sha256: 'demo-checksum' }),
        row(orgA, 4, { storageKey: key('organizations', orgA, 5) }),
        row(orgA, 4, { storageKey: `${key('organizations', orgA, 4)}/../x` }),
      ]) {
        await expect(
          chunks.upsertChunkFileObjects({ ...base, chunks: [bad] }),
        ).rejects.toMatchObject({
          code: 'invalid_chunk_row',
        });
      }
    });

    it('file_objects.checksum_sha256 CHECK rejects non-hex for new rows', async () => {
      await expect(
        runWithOrganizationContext(app, orgA, (tx) =>
          tx.fileObject.create({
            data: {
              organizationId: orgA,
              bucket: 'b',
              key: `org/${orgA}/x-${randomUUID()}`,
              mimeType: 'a/b',
              checksumSha256: 'demo-checksum',
            },
          }),
        ),
      ).rejects.toThrow(/checksum_sha256_check|23514/);
    });
  });
  describe('RecordingOwnershipVerifier + RecordingChunkPersistence (single transaction)', () => {
    /** Org B's real meeting with org A's recording: the forged job from the #118 review. */
    const forged = () => ({
      organizationId: orgB,
      meetingId: scope.get(orgB)!.meetingId,
      recordingId: scope.get(orgA)!.recordingId,
    });
    const forgedKey = (i: number) => {
      const f = forged();
      return `organizations/${orgB}/meetings/${f.meetingId}/processed/${f.recordingId}/chunks/${String(i).padStart(5, '0')}.wav`;
    };
    const countFileObjects = (org: string) =>
      runWithOrganizationContext(owner, org, (tx) => tx.fileObject.count());
    const chunkCountOf = (org: string) =>
      runWithOrganizationContext(owner, org, (tx) =>
        tx.recording.findUniqueOrThrow({ where: { id: scope.get(org)!.recordingId } }),
      ).then((r) => r.chunkCount);

    it('verifies only the exact (organization, meeting, recording) under RLS', async () => {
      expect(await verifier.verifyRecording({ organizationId: orgA, ...scope.get(orgA)! })).toBe(
        true,
      );
      expect(await verifier.verifyRecording({ organizationId: orgB, ...scope.get(orgB)! })).toBe(
        true,
      );
      expect(await verifier.verifyRecording(forged())).toBe(false);
      expect(await verifier.verifyRecording({ organizationId: orgB, ...scope.get(orgA)! })).toBe(
        false,
      );
      expect(
        await verifier.verifyRecording({
          organizationId: orgA,
          meetingId: scope.get(orgB)!.meetingId,
          recordingId: scope.get(orgA)!.recordingId,
        }),
      ).toBe(false);
    });

    it('forged job: org B claiming its real meeting with org A recording leaves no rows anywhere', async () => {
      const beforeA = await countFileObjects(orgA);
      const beforeB = await countFileObjects(orgB);
      const countA = await chunkCountOf(orgA);
      const rows = [0, 1].map((i) => row(orgB, i, { storageKey: forgedKey(i) }));
      await expect(atomic.persistChunks({ ...forged(), chunks: rows })).rejects.toMatchObject({
        code: 'chunk_count_not_updated',
      });
      expect(await countFileObjects(orgB)).toBe(beforeB);
      expect(await countFileObjects(orgA)).toBe(beforeA);
      for (const r of rows) {
        expect(
          await lookup.findFileObject({ organizationId: orgB, fileObjectId: r.fileObjectId }),
        ).toBeNull();
      }
      expect(await chunkCountOf(orgA)).toBe(countA);
      expect(await chunkCountOf(orgB)).toBeNull();
    });

    it('writes chunk rows and chunk_count together, idempotently', async () => {
      const rows = [row(orgB, 0), row(orgB, 1)];
      const q = { organizationId: orgB, ...scope.get(orgB)!, chunks: rows };
      await atomic.persistChunks(q);
      await atomic.persistChunks(q); // retry
      expect(await chunkCountOf(orgB)).toBe(2);
      for (const r of rows) {
        expect(
          await lookup.findFileObject({ organizationId: orgB, fileObjectId: r.fileObjectId }),
        ).toMatchObject({ organizationId: orgB, kind: 'chunk', key: r.storageKey });
      }
      // A conflicting row rolls back the new count and the fresh row in the same transaction.
      const fresh = row(orgB, 2);
      const moved = { ...rows[0]!, storageKey: key('organizations', orgB, 3), index: 3 };
      await expect(
        atomic.persistChunks({ ...q, chunks: [fresh, rows[1]!, moved] }),
      ).rejects.toMatchObject({
        code: 'chunk_file_object_conflict',
      });
      expect(await chunkCountOf(orgB)).toBe(2);
      expect(
        await lookup.findFileObject({ organizationId: orgB, fileObjectId: fresh.fileObjectId }),
      ).toBeNull();
    });

    it('a soft-deleted recording is neither verified nor written', async () => {
      const s = await runWithOrganizationContext(owner, orgA, async (tx) => {
        const meetingId = scope.get(orgA)!.meetingId;
        const file = await tx.fileObject.create({
          data: {
            organizationId: orgA,
            meetingId,
            bucket: 'b',
            key: `organizations/${orgA}/meetings/${meetingId}/recordings/${randomUUID()}.webm`,
            mimeType: 'audio/webm',
          },
        });
        const rec = await tx.recording.create({
          data: { organizationId: orgA, meetingId, fileObjectId: file.id, deletedAt: new Date() },
        });
        return { meetingId, recordingId: rec.id };
      });
      expect(await verifier.verifyRecording({ organizationId: orgA, ...s })).toBe(false);
      const r = row(orgA, 0, {
        storageKey: `organizations/${orgA}/meetings/${s.meetingId}/processed/${s.recordingId}/chunks/00000.wav`,
      });
      await expect(
        atomic.persistChunks({ organizationId: orgA, ...s, chunks: [r] }),
      ).rejects.toMatchObject({
        code: 'chunk_count_not_updated',
      });
      expect(
        await lookup.findFileObject({ organizationId: orgA, fileObjectId: r.fileObjectId }),
      ).toBeNull();
    });
  });
});
