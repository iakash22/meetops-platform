import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildObjectKey, type MeetingObjectRef, type PutObjectBody } from '@meetops/storage';
import {
  assembleRecordingSession,
  sessionRecordingId,
  type AssembledRecording,
  type AssemblySession,
  type SessionAssemblyDeps,
} from '../src/media/assemble-session.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const MEET = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const CONSENT = '00000000-0000-4000-8000-000000000004';
const job = {
  jobVersion: 1,
  kind: 'assemble_recording_session',
  organizationId: ORG,
  meetingId: MEET,
  sessionId: SESSION,
  consentAttestationId: CONSENT,
  sourceExt: 'webm',
} as const;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Streams each object in small slices so the assembler sees many reads per chunk. */
function memStorage() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  let maxRead = 0;
  return {
    objects,
    deleted,
    get maxRead() {
      return maxRead;
    },
    storage: {
      async getObject(ref: MeetingObjectRef) {
        const b = objects.get(buildObjectKey(ref));
        if (!b) throw new Error('NoSuchKey');
        const slices = [];
        for (let i = 0; i < b.length; i += 4) slices.push(b.subarray(i, i + 4));
        return { body: Readable.from(slices), info: { sizeBytes: b.length } };
      },
      async headObject(ref: MeetingObjectRef) {
        const b = objects.get(buildObjectKey(ref));
        return b ? { sizeBytes: b.length } : null;
      },
      async putObject(ref: MeetingObjectRef, body: PutObjectBody) {
        const parts: Buffer[] = [];
        for await (const c of body as Readable) {
          maxRead = Math.max(maxRead, (c as Buffer).length);
          parts.push(c as Buffer);
        }
        objects.set(buildObjectKey(ref), Buffer.concat(parts));
        return {};
      },
      async deleteObject(ref: MeetingObjectRef) {
        const k = buildObjectKey(ref);
        deleted.push(k);
        objects.delete(k);
      },
    },
  };
}

function setup(parts: Buffer[], over: { stored?: Buffer[]; maxBytes?: number } = {}) {
  const mem = memStorage();
  const chunkKey = (seq: number) =>
    buildObjectKey({
      kind: 'session_chunk',
      organizationId: ORG,
      meetingId: MEET,
      objectId: SESSION,
      index: seq,
    });
  (over.stored ?? parts).forEach((b, i) => mem.objects.set(chunkKey(i), b));
  const session: AssemblySession = {
    meetingId: MEET,
    status: 'completed',
    mimeType: 'video/webm;codecs=vp9,opus',
    chunkCount: parts.length,
    chunks: parts.map((b, seq) => ({ seq, sizeBytes: b.length, sha256: sha(b) })),
    assembled: null,
  };
  const recorded: AssembledRecording[] = [];
  const failed: unknown[] = [];
  const enqueued: { name: string; data: unknown; opts: { jobId: string } }[] = [];
  const statuses: unknown[] = [];
  const deps: SessionAssemblyDeps = {
    storage: mem.storage,
    store: {
      loadSession: async () => session,
      recordAssembled: async (r) => {
        recorded.push(r);
        session.assembled = {
          recordingId: r.recordingId,
          sizeBytes: r.sizeBytes,
          sha256: r.sha256,
        };
      },
      recordProcessingFailed: async (p) => {
        failed.push(p);
      },
    },
    mediaQueue: { add: async (name, data, opts) => enqueued.push({ name, data, opts }) },
    realtime: { meetingStatus: (e) => statuses.push(e) },
    logger: silent,
    now: () => new Date('2026-10-28T00:00:00.000Z'),
    ...(over.maxBytes ? { maxBytes: over.maxBytes } : {}),
  };
  const target = buildObjectKey({
    kind: 'recording',
    organizationId: ORG,
    meetingId: MEET,
    objectId: sessionRecordingId(SESSION),
    ext: 'webm',
  });
  return { mem, deps, session, recorded, failed, enqueued, statuses, chunkKey, target };
}

const A = Buffer.from('first-chunk-bytes-');
const B = Buffer.from('second-chunk-bytes-');
const C = Buffer.from('third');

describe('assembleRecordingSession', () => {
  it('streams verified chunks into the deterministic key, records it, deletes chunks, enqueues process_recording', async () => {
    const t = setup([A, B, C]);
    const r = await assembleRecordingSession(job, t.deps);
    const whole = Buffer.concat([A, B, C]);
    expect(r).toMatchObject({ status: 'assembled', sizeBytes: whole.length, sha256: sha(whole) });
    expect(t.mem.objects.get(t.target)).toEqual(whole);
    expect(t.mem.maxRead).toBeLessThanOrEqual(4); // never more than one read slice buffered
    expect(t.recorded).toHaveLength(1);
    expect(t.recorded[0]).toMatchObject({ mimeType: 'video/webm', sizeBytes: whole.length });
    for (const seq of [0, 1, 2]) expect(t.mem.objects.has(t.chunkKey(seq))).toBe(false);
    expect(t.enqueued).toEqual([
      {
        name: 'process_recording',
        data: {
          jobVersion: 1,
          kind: 'process_recording',
          organizationId: ORG,
          meetingId: MEET,
          recordingId: sessionRecordingId(SESSION),
          sourceExt: 'webm',
        },
        opts: { jobId: `media_${ORG}_${sessionRecordingId(SESSION)}` },
      },
    ]);
  });

  it('aborts on the cap while streaming (stored part bigger than signed), keeps every chunk', async () => {
    const big = Buffer.alloc(64, 1);
    const t = setup([A, B], { stored: [A, big], maxBytes: A.length + B.length });
    await expect(assembleRecordingSession(job, t.deps)).rejects.toMatchObject({
      code: 'assembly_cap_exceeded',
    });
    expect(t.mem.objects.has(t.chunkKey(0))).toBe(true);
    expect(t.mem.objects.has(t.chunkKey(1))).toBe(true);
    expect(t.mem.objects.has(t.target)).toBe(false);
    expect(t.recorded).toHaveLength(0);
    expect(t.enqueued).toHaveLength(0);
  });

  it('rejects up front when the signed sizes already exceed the cap', async () => {
    const t = setup([A, B], { maxBytes: A.length });
    await expect(assembleRecordingSession(job, t.deps)).rejects.toMatchObject({
      code: 'assembly_cap_exceeded',
    });
    expect(t.mem.deleted.filter((k) => k !== t.target)).toEqual([]);
  });

  it('fails on a bad chunk checksum without deleting chunks; final attempt writes the outbox event', async () => {
    const tampered = Buffer.from(B);
    tampered[0] = 0x58;
    const t = setup([A, B, C], { stored: [A, tampered, C] });
    await expect(
      assembleRecordingSession(job, t.deps, { isFinalAttempt: false }),
    ).rejects.toMatchObject({
      code: 'assembly_checksum_mismatch',
    });
    expect(t.failed).toHaveLength(0);
    await expect(
      assembleRecordingSession(job, t.deps, { isFinalAttempt: true }),
    ).rejects.toMatchObject({
      code: 'assembly_checksum_mismatch',
    });
    for (const seq of [0, 1, 2]) expect(t.mem.objects.has(t.chunkKey(seq))).toBe(true);
    expect(t.mem.deleted.every((k) => k === t.target)).toBe(true);
    expect(t.mem.objects.has(t.target)).toBe(false);
    expect(t.failed).toEqual([
      {
        organizationId: ORG,
        meetingId: MEET,
        subjectType: 'recording_session',
        subjectId: SESSION,
        errorCode: 'assembly_checksum_mismatch',
        failedAt: '2026-10-28T00:00:00.000Z',
      },
    ]);
    expect(t.statuses).toHaveLength(1);
  });

  it('keeps chunks when the read-back verification fails', async () => {
    const t = setup([A, B]);
    const put = t.mem.storage.putObject.bind(t.mem.storage);
    t.mem.storage.putObject = async (ref, body) => {
      await put(ref, body);
      t.mem.objects.set(buildObjectKey(ref), Buffer.alloc(A.length + B.length, 0)); // same size, wrong bytes
      return {};
    };
    await expect(assembleRecordingSession(job, t.deps)).rejects.toMatchObject({
      code: 'assembly_verify_failed',
    });
    expect(t.mem.objects.has(t.chunkKey(0))).toBe(true);
    expect(t.mem.objects.has(t.chunkKey(1))).toBe(true);
    expect(t.recorded).toHaveLength(0);
  });

  it('is retry-safe: a crash after recording skips re-assembly and finishes delete + enqueue idempotently', async () => {
    const t = setup([A, B]);
    const del = t.mem.storage.deleteObject.bind(t.mem.storage);
    let crash = true;
    t.mem.storage.deleteObject = async (ref) => {
      if (crash && ref.kind === 'session_chunk') throw new Error('network');
      return del(ref);
    };
    await expect(assembleRecordingSession(job, t.deps, { isFinalAttempt: false })).rejects.toThrow(
      'network',
    );
    expect(t.recorded).toHaveLength(1);
    expect(t.mem.objects.has(t.chunkKey(0))).toBe(true);
    crash = false;
    let puts = 0;
    const put = t.mem.storage.putObject.bind(t.mem.storage);
    t.mem.storage.putObject = async (ref, body) => {
      puts++;
      return put(ref, body);
    };
    const r = await assembleRecordingSession(job, t.deps);
    expect(r.status).toBe('already_assembled');
    expect(puts).toBe(0);
    expect(t.recorded).toHaveLength(1);
    expect(t.mem.objects.has(t.chunkKey(0))).toBe(false);
    // A third run (duplicate delivery) is a no-op apart from the idempotent enqueue (same jobId).
    await assembleRecordingSession(job, t.deps);
    expect(new Set(t.enqueued.map((e) => e.opts.jobId)).size).toBe(1);
  });

  it('refuses invalid jobs and sessions that are not completed', async () => {
    const t = setup([A]);
    await expect(
      assembleRecordingSession({ ...job, sourceExt: 'exe' }, t.deps),
    ).rejects.toMatchObject({
      code: 'invalid_job',
    });
    t.session.status = 'uploading';
    await expect(assembleRecordingSession(job, t.deps)).rejects.toMatchObject({
      code: 'session_not_ready',
    });
    expect(t.mem.objects.has(t.chunkKey(0))).toBe(true);
  });
});
