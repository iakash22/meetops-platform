import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts';
import { StorageNotFoundError } from '@meetops/storage';
import {
  concatenateChunks,
  processSessionAssembly,
  type AssemblyChunk,
  type ConcatOutcome,
  type AssemblySession,
  type SessionAssemblyDeps,
  type SessionAssemblyStore,
} from '../src/media/index.js';

// Dummy media only: synthetic bytes, never real audio/video.
const ORG = '11111111-1111-4111-8111-111111111111';
const MEETING = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const REC = '44444444-4444-4444-8444-444444444444';
const FILE = '55555555-5555-4555-8555-555555555555';
const CONSENT = '66666666-6666-4666-8666-666666666666';
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const job = {
  kind: 'process_recording_session',
  organizationId: ORG,
  subjectType: 'recording_session',
  subjectId: SID,
  consentAttestationId: CONSENT,
  meetingId: MEETING,
};

function world(parts: Buffer[], tweak: (s: AssemblySession) => void = () => undefined) {
  const objects = new Map<string, Buffer>();
  const chunks: AssemblyChunk[] = parts.map((b, seq) => {
    const key = `organizations/${ORG}/recording-sessions/${SID}/chunks/${String(seq).padStart(5, '0')}`;
    objects.set(key, b);
    return { seq, sizeBytes: b.length, sha256Hex: hex(b), key };
  });
  const sourceKey = `organizations/${ORG}/meetings/${MEETING}/recordings/${REC}.webm`;
  const session: AssemblySession = {
    id: SID,
    organizationId: ORG,
    meetingId: MEETING,
    status: 'completed',
    chunkCount: parts.length,
    totalBytes: parts.reduce((n, b) => n + b.length, 0),
    mimeType: 'video/webm',
    recordingId: REC,
    file: {
      id: FILE,
      key: sourceKey,
      status: 'pending_upload',
      checksumSha256Hex: null,
      scanStatus: 'pending',
    },
    chunks,
    deleted: null,
    consent: {
      id: CONSENT,
      consentVersion: CURRENT_CONSENT_VERSION,
      attestedAt: new Date(),
      recordedAt: new Date(),
    },
  };
  tweak(session);
  const store = {
    load: vi.fn(async () => structuredClone(session)),
    markAssembled: vi.fn(async (_o: string, a: { sizeBytes: number; sha256Hex: string }) => {
      session.file!.status = 'uploaded';
      session.file!.checksumSha256Hex = a.sha256Hex;
    }),
    markFailed: vi.fn(async () => {
      session.status = 'failed';
    }),
    setScanStatus: vi.fn(async (_o: string, _f: string, v: 'clean' | 'quarantined') => {
      session.file!.scanStatus = v;
    }),
  } satisfies SessionAssemblyStore;
  const maxChunkReads = { n: 0 };
  const deps: SessionAssemblyDeps = {
    store,
    maxSourceBytes: 1024 * 1024,
    sourceExt: () => 'webm',
    objects: () => ({
      readChunk: async (c) => {
        const b = objects.get(c.key);
        if (!b) throw new StorageNotFoundError();
        maxChunkReads.n++;
        // Two small parts per chunk: proves streaming across part boundaries.
        return Readable.from([b.subarray(0, 3), b.subarray(3)]);
      },
      deleteChunk: async (c) => {
        objects.delete(c.key);
      },
      putSource: async (body, spec) => {
        const got: Buffer[] = [];
        for await (const p of body) got.push(Buffer.from(p as Buffer));
        const all = Buffer.concat(got);
        if (all.length !== spec.sizeBytes) throw new Error('content-length mismatch');
        objects.set(sourceKey, all);
      },
      headSource: async () => {
        const b = objects.get(sourceKey);
        return b ? { sizeBytes: b.length } : null;
      },
      deleteSource: async () => {
        objects.delete(sourceKey);
      },
      sourceBody: async () => Readable.from([objects.get(sourceKey)!]),
    }),
    scan: vi.fn(async () => 'clean' as const),
    process: vi.fn(async () => ({})),
  };
  return { session, store, deps, objects, sourceKey, chunks, reads: maxChunkReads };
}

const A = Buffer.from('dummy-chunk-0-bytes');
const B = Buffer.from('dummy-chunk-1-more-bytes');

describe('processSessionAssembly', () => {
  it('happy path: concatenates in order, stores the final sha256, deletes chunks, scans then processes', async () => {
    const w = world([A, B]);
    const out = await processSessionAssembly(job, w.deps);
    const all = Buffer.concat([A, B]);
    expect(out).toEqual({ status: 'processed', sizeBytes: all.length, sha256Hex: hex(all) });
    expect(w.objects.get(w.sourceKey)).toEqual(all);
    expect(w.store.markAssembled).toHaveBeenCalledWith(ORG, {
      sessionId: SID,
      fileObjectId: FILE,
      recordingId: REC,
      sizeBytes: all.length,
      sha256Hex: hex(all),
    });
    for (const c of w.chunks) expect(w.objects.has(c.key)).toBe(false);
    expect(w.store.setScanStatus).toHaveBeenCalledWith(ORG, FILE, 'clean');
    expect(w.deps.process).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_recording',
        recordingId: REC,
        meetingId: MEETING,
        sourceExt: 'webm',
        sourceKey: w.sourceKey,
      }),
      { isFinalAttempt: true },
    );
  });

  it('ADTS AAC segments (mobile, ADR-015): per-chunk and whole-file sha256 verify unchanged', async () => {
    // Dummy ADTS frames (header + zero payload): each segment is self-delimiting, so byte concatenation is valid.
    const frame = (len: number, fill: number) => {
      const f = Buffer.alloc(len, fill);
      f.set([
        0xff,
        0xf1,
        0x50,
        0x80 | ((len >> 11) & 3),
        (len >> 3) & 0xff,
        ((len & 7) << 5) | 0x1f,
        0xfc,
      ]);
      return f;
    };
    const seg0 = Buffer.concat([frame(40, 1), frame(41, 2)]);
    const seg1 = Buffer.concat([frame(39, 3)]);
    const w = world([seg0, seg1], (s) => {
      s.mimeType = 'audio/aac';
    });
    w.deps.sourceExt = () => 'aac';
    const out = await processSessionAssembly(job, w.deps);
    const all = Buffer.concat([seg0, seg1]);
    // Same chain as every other type: chunk hashes checked while streaming, the final hash over the joined bytes.
    expect(w.chunks.map((c) => c.sha256Hex)).toEqual([hex(seg0), hex(seg1)]);
    expect(out).toEqual({ status: 'processed', sizeBytes: all.length, sha256Hex: hex(all) });
    expect(w.objects.get(w.sourceKey)).toEqual(all);
    expect(w.deps.process).toHaveBeenCalledWith(
      expect.objectContaining({ sourceExt: 'aac' }),
      expect.anything(),
    );
  });

  it('quarantined scan: never processes', async () => {
    const w = world([A]);
    vi.mocked(w.deps.scan).mockResolvedValueOnce('quarantined');
    expect((await processSessionAssembly(job, w.deps)).status).toBe('quarantined');
    expect(w.deps.process).not.toHaveBeenCalled();
  });

  it('size mismatch: fails the session, leaves no source, reclaims the chunks (#303 L-1)', async () => {
    const w = world([A, B]);
    w.objects.set(w.chunks[1]!.key, Buffer.concat([B, Buffer.from('extra')]));
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'chunk_size_mismatch',
    });
    expect(w.objects.has(w.sourceKey)).toBe(false);
    expect(w.store.markFailed).toHaveBeenCalledWith(ORG, {
      sessionId: SID,
      fileObjectId: FILE,
      recordingId: REC,
      code: 'chunk_size_mismatch',
    });
    expect(w.store.markAssembled).not.toHaveBeenCalled();
    for (const c of w.chunks) expect(w.objects.has(c.key)).toBe(false);
    expect(w.deps.scan).not.toHaveBeenCalled();
  });

  it('declared total mismatch: fails before reading anything', async () => {
    const w = world([A, B], (s) => {
      s.totalBytes += 1;
    });
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'total_size_mismatch',
    });
    expect(w.reads.n).toBe(0);
  });

  it('sha256 mismatch (same size): fails, no source', async () => {
    const w = world([A, B]);
    const evil = Buffer.from(B);
    evil[0] = evil[0]! ^ 1;
    w.objects.set(w.chunks[1]!.key, evil);
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'chunk_sha256_mismatch',
    });
    expect(w.objects.has(w.sourceKey)).toBe(false);
    for (const c of w.chunks) expect(w.objects.has(c.key)).toBe(false); // #303 L-1
  });

  it('missing chunk object or row: fails cleanly', async () => {
    const w = world([A, B]);
    w.objects.delete(w.chunks[1]!.key);
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'chunk_missing',
    });
    expect(w.objects.has(w.sourceKey)).toBe(false);
    expect(w.objects.has(w.chunks[0]!.key)).toBe(false); // #303 L-1: the remaining chunk is reclaimed
    const w2 = world([A, B], (s) => {
      s.chunks = [s.chunks[0]!];
    });
    expect(await processSessionAssembly(job, w2.deps)).toEqual({
      status: 'failed',
      code: 'chunk_missing',
    });
  });

  it('size cap: refuses before reading', async () => {
    const w = world([A, B]);
    w.deps.maxSourceBytes = A.length;
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'size_cap_exceeded',
    });
    expect(w.reads.n).toBe(0);
  });

  it('retry is idempotent: after a verified assembly it never re-reads chunks or re-assembles', async () => {
    const w = world([A, B]);
    vi.mocked(w.deps.process).mockRejectedValueOnce(new Error('ffmpeg down'));
    await expect(processSessionAssembly(job, w.deps, { isFinalAttempt: false })).rejects.toThrow(
      'ffmpeg down',
    );
    const reads = w.reads.n;
    const out = await processSessionAssembly(job, w.deps);
    expect(out.status).toBe('processed');
    expect(w.reads.n).toBe(reads);
    expect(w.store.markAssembled).toHaveBeenCalledOnce();
    expect(w.deps.scan).toHaveBeenCalledOnce();
    expect(w.objects.get(w.sourceKey)).toEqual(Buffer.concat([A, B]));
  });

  it('infra error mid-stream: rethrows for a retry (no source), fails only on the final attempt', async () => {
    const w = world([A, B]);
    const objs = w.deps.objects;
    w.deps.objects = (s) => ({
      ...objs(s),
      readChunk: async () => {
        throw new Error('s3 down');
      },
    });
    await expect(processSessionAssembly(job, w.deps, { isFinalAttempt: false })).rejects.toThrow(
      's3 down',
    );
    expect(w.store.markFailed).not.toHaveBeenCalled();
    expect(await processSessionAssembly(job, w.deps)).toEqual({
      status: 'failed',
      code: 'assembly_unavailable',
    });
    expect(w.objects.has(w.sourceKey)).toBe(false);
  });

  it('skips invalid jobs, unknown, failed and uncompleted sessions', async () => {
    const w = world([A]);
    expect(await processSessionAssembly({ ...job, kind: 'x' }, w.deps)).toEqual({
      status: 'skipped',
      reason: 'invalid_job',
    });
    w.store.load.mockResolvedValueOnce(null as never);
    expect((await processSessionAssembly(job, w.deps)).status).toBe('skipped');
    const w2 = world([A], (s) => {
      s.status = 'failed';
    });
    expect(await processSessionAssembly(job, w2.deps)).toEqual({
      status: 'skipped',
      reason: 'already_failed',
    });
  });

  describe('#303 M-1: deleted parents or invalid consent skip and reclaim the chunks', () => {
    const expectSkippedClean = async (
      w: ReturnType<typeof world>,
      reason: string,
      j: object = job,
    ) => {
      expect(await processSessionAssembly(j, w.deps)).toEqual({ status: 'skipped', reason });
      expect(w.reads.n).toBe(0);
      expect(w.objects.has(w.sourceKey)).toBe(false);
      for (const c of w.chunks) expect(w.objects.has(c.key)).toBe(false);
      expect(w.store.markAssembled).not.toHaveBeenCalled();
      expect(w.deps.scan).not.toHaveBeenCalled();
      expect(w.deps.process).not.toHaveBeenCalled();
      if (reason === 'consent_invalid') {
        // #303 L-4: rows failed so the backfill never re-picks it.
        expect(w.store.markFailed).toHaveBeenCalledWith(ORG, {
          sessionId: SID,
          fileObjectId: FILE,
          recordingId: REC,
          code: 'consent_invalid',
        });
        expect(w.session.status).toBe('failed');
      } else {
        expect(w.store.markFailed).not.toHaveBeenCalled();
      }
    };
    for (const d of ['organization', 'meeting', 'recording', 'file'] as const) {
      it(`${d} soft-deleted after complete`, async () => {
        await expectSkippedClean(
          world([A, B], (s) => {
            s.deleted = d;
          }),
          'deleted',
        );
      });
    }
    it('no stored consent', async () => {
      await expectSkippedClean(
        world([A], (s) => {
          s.consent = null;
        }),
        'consent_invalid',
      );
    });
    it("#303 L-4: job's consentAttestationId differs from a VALID stored one: skip, keep everything", async () => {
      const w = world([A, B]);
      expect(
        await processSessionAssembly(
          { ...job, consentAttestationId: '77777777-7777-4777-8777-777777777777' },
          w.deps,
        ),
      ).toEqual({ status: 'skipped', reason: 'consent_mismatch' });
      for (const c of w.chunks) expect(w.objects.has(c.key)).toBe(true);
      expect(w.store.markFailed).not.toHaveBeenCalled();
      expect(w.reads.n).toBe(0);
      // The right job later assembles it normally.
      expect((await processSessionAssembly(job, w.deps)).status).toBe('processed');
    });
    it('stored consent has an unsupported version', async () => {
      await expectSkippedClean(
        world([A], (s) => {
          s.consent!.consentVersion = '1999-01';
        }),
        'consent_invalid',
      );
    });
    it('stored consent attested outside the skew window', async () => {
      await expectSkippedClean(
        world([A], (s) => {
          s.consent!.attestedAt = new Date(s.consent!.recordedAt.getTime() + 301_000);
        }),
        'consent_invalid',
      );
    });
  });

  describe('#303 M-3: stream errors fail one job, never the process', () => {
    const watchUncaught = () => {
      const seen: unknown[] = [];
      const h = (e: unknown) => seen.push(e);
      process.on('uncaughtException', h);
      return { seen, stop: () => process.off('uncaughtException', h) };
    };
    it('a sha mismatch / read error ends the body without an error event, withholds the bad bytes, aborts', async () => {
      const u = watchUncaught();
      try {
        const evil = Buffer.from(B);
        evil[0] = evil[0]! ^ 1;
        for (const [name, read] of [
          ['sha', async (c: { key: string }) => Readable.from([c.key === 'k0' ? A : evil])],
          [
            'econnreset',
            async (c: { key: string }) => {
              if (c.key === 'k0') return Readable.from([A]);
              const r = new Readable({ read() {} });
              setImmediate(() =>
                r.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
              );
              return r;
            },
          ],
        ] as const) {
          const onFail = vi.fn();
          const out: ConcatOutcome = { onFail };
          const body = concatenateChunks(
            [
              { seq: 0, sizeBytes: A.length, sha256Hex: hex(A), key: 'k0' },
              { seq: 1, sizeBytes: B.length, sha256Hex: hex(B), key: 'k1' },
            ],
            read,
            out,
          );
          const errors: unknown[] = [];
          body.on('error', (e) => errors.push(e));
          const got: Buffer[] = [];
          for await (const p of body) got.push(Buffer.from(p as Buffer));
          expect(errors, name).toEqual([]);
          expect(Buffer.concat(got).length, name).toBeLessThan(A.length + B.length);
          expect(onFail, name).toHaveBeenCalledOnce();
          if (name === 'sha') expect(out.failure?.code).toBe('chunk_sha256_mismatch');
          else expect((out.error as { code?: string }).code).toBe('ECONNRESET');
        }
        await new Promise((r) => setTimeout(r, 20));
        expect(u.seen).toEqual([]);
      } finally {
        u.stop();
      }
    });
    it('the worker fails the bad job and then processes the next one', async () => {
      const u = watchUncaught();
      try {
        const bad = world([A, B]);
        const objs = bad.deps.objects;
        bad.deps.objects = (s) => ({
          ...objs(s),
          readChunk: async (c) => {
            if (c.seq === 0) return Readable.from([A]);
            const r = new Readable({ read() {} });
            setImmediate(() =>
              r.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
            );
            return r;
          },
          putSource: async (body, spec) => {
            const got: Buffer[] = [];
            for await (const p of body) got.push(Buffer.from(p as Buffer));
            if (Buffer.concat(got).length !== spec.sizeBytes) throw new Error('short body');
          },
        });
        expect(await processSessionAssembly(job, bad.deps)).toEqual({
          status: 'failed',
          code: 'assembly_unavailable',
        });
        const good = world([A, B]);
        expect((await processSessionAssembly(job, good.deps)).status).toBe('processed');
        await new Promise((r) => setTimeout(r, 20));
        expect(u.seen).toEqual([]);
      } finally {
        u.stop();
      }
    });
  });
});
