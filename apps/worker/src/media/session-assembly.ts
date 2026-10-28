import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MAX_RECORDING_SESSION_BYTES, type MediaJobPayload } from '@meetops/contracts';
import { StorageNotFoundError } from '@meetops/storage';
import './ids.js'; // registers the contracts uuid format

const Uuid = Type.String({ format: 'uuid' });

/** The job the API enqueues on recording-session complete (`apps/api` MediaProcessingJob, kind process_recording_session). */
export const SessionAssemblyJob = Type.Object(
  {
    kind: Type.Literal('process_recording_session'),
    organizationId: Uuid,
    subjectType: Type.Literal('recording_session'),
    subjectId: Uuid,
    consentAttestationId: Uuid,
    meetingId: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);
export type SessionAssemblyJob = Static<typeof SessionAssemblyJob>;

export type AssemblyChunk = { seq: number; sizeBytes: number; sha256Hex: string; key: string };

/** A completed session with its recording + source FileObject, read under the job's org (forced RLS). */
export type AssemblySession = {
  id: string;
  organizationId: string;
  meetingId: string;
  status: 'uploading' | 'completed' | 'aborted' | 'failed';
  chunkCount: number | null;
  totalBytes: number;
  mimeType: string;
  recordingId: string | null;
  file: {
    id: string;
    key: string;
    status: string;
    checksumSha256Hex: string | null;
    scanStatus: 'pending' | 'clean' | 'quarantined' | 'rejected';
  } | null;
  /** Ordered by seq. */
  chunks: AssemblyChunk[];
};

export type SessionAssemblyStore = {
  load(organizationId: string, sessionId: string): Promise<AssemblySession | null>;
  /** Source FileObject -> uploaded (size + final sha256), recording -> uploaded. One transaction. */
  markAssembled(
    organizationId: string,
    s: { sessionId: string; fileObjectId: string; recordingId: string; sizeBytes: number; sha256Hex: string },
  ): Promise<void>;
  /** Session -> failed (failure_code), source FileObject + recording -> failed. One transaction. */
  markFailed(
    organizationId: string,
    s: { sessionId: string; fileObjectId: string | null; recordingId: string | null; code: AssemblyFailureCode },
  ): Promise<void>;
  /** Sets scanStatus only while it is still pending (idempotent). */
  setScanStatus(organizationId: string, fileObjectId: string, status: 'clean' | 'quarantined'): Promise<void>;
};

/** Object access for one session; implementations bind keys to the job's org + meeting/session. */
export type SessionObjects = {
  readChunk(chunk: AssemblyChunk): Promise<Readable>;
  deleteChunk(chunk: AssemblyChunk): Promise<void>;
  /** Single PUT of the assembled source (atomic: a failed body stream stores nothing). */
  putSource(body: Readable, spec: { sizeBytes: number; mimeType: string }): Promise<void>;
  headSource(): Promise<{ sizeBytes: number } | null>;
  deleteSource(): Promise<void>;
  sourceBody(): Promise<Readable>;
};

export type AssemblyFailureCode =
  | 'chunk_set_invalid'
  | 'chunk_missing'
  | 'chunk_size_mismatch'
  | 'chunk_sha256_mismatch'
  | 'total_size_mismatch'
  | 'size_cap_exceeded'
  | 'unsupported_mime'
  | 'assembly_unavailable';

export class AssemblyError extends Error {
  constructor(readonly code: AssemblyFailureCode) {
    super(code);
    this.name = 'AssemblyError';
  }
}

export type SessionAssemblyDeps = {
  store: SessionAssemblyStore;
  objects(s: AssemblySession & { recordingId: string; file: NonNullable<AssemblySession['file']> }): SessionObjects;
  /** Hard cap on the assembled source (worker MEDIA_MAX_SOURCE_BYTES), never above MAX_RECORDING_SESSION_BYTES. */
  maxSourceBytes: number;
  /** The normal content scan (magic bytes, ffprobe, optional clamd) on the assembled source. */
  scan(source: { size(): Promise<number | null>; body(): Promise<Readable> }, mimeType: string): Promise<'clean' | 'quarantined'>;
  /** The normal recording pipeline (processRecording) for a clean source. */
  process(payload: MediaJobPayload, ctx: { isFinalAttempt: boolean }): Promise<unknown>;
  sourceExt(mimeType: string): MediaJobPayload['sourceExt'] | null;
};

export type SessionAssemblyOutcome =
  | { status: 'skipped'; reason: 'invalid_job' | 'not_found' | 'not_completed' | 'already_failed' }
  | { status: 'failed'; code: AssemblyFailureCode }
  | { status: 'quarantined'; sizeBytes: number; sha256Hex: string }
  | { status: 'processed'; sizeBytes: number; sha256Hex: string };

/** Ordered, contiguous 0..n-1 chunk set whose sizes add up to the session total and fit the cap. */
export function checkChunkSet(s: AssemblySession, maxSourceBytes: number): number {
  const n = s.chunkCount ?? 0;
  if (n < 1 || s.chunks.length !== n) throw new AssemblyError(s.chunks.length < n ? 'chunk_missing' : 'chunk_set_invalid');
  let total = 0;
  s.chunks.forEach((c, i) => {
    if (c.seq !== i || !/^[0-9a-f]{64}$/.test(c.sha256Hex) || c.sizeBytes < 1) {
      throw new AssemblyError(c.seq > i ? 'chunk_missing' : 'chunk_set_invalid');
    }
    total += c.sizeBytes;
  });
  if (total !== s.totalBytes) throw new AssemblyError('total_size_mismatch');
  if (total > Math.min(maxSourceBytes, MAX_RECORDING_SESSION_BYTES)) throw new AssemblyError('size_cap_exceeded');
  return total;
}

/**
 * Streams the chunks in order (never buffering a whole chunk or file), verifying each chunk's size + sha256 as it
 * passes, and the full-file sha256. A mismatch aborts the body stream, so the single PUT stores nothing.
 */
export function concatenateChunks(
  chunks: AssemblyChunk[],
  read: (c: AssemblyChunk) => Promise<Readable>,
  out: { sha256Hex?: string; failure?: AssemblyError },
): Readable {
  const total = createHash('sha256');
  async function* gen() {
    try {
      for (const c of chunks) {
        let body: Readable;
        try {
          body = await read(c);
        } catch (err) {
          if (err instanceof StorageNotFoundError) throw new AssemblyError('chunk_missing');
          throw err;
        }
        const h = createHash('sha256');
        let n = 0;
        for await (const part of body as AsyncIterable<Buffer | Uint8Array | string>) {
          const buf = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part);
          n += buf.length;
          if (n > c.sizeBytes) {
            body.destroy();
            throw new AssemblyError('chunk_size_mismatch');
          }
          h.update(buf);
          total.update(buf);
          yield buf;
        }
        if (n !== c.sizeBytes) throw new AssemblyError('chunk_size_mismatch');
        if (h.digest('hex') !== c.sha256Hex) throw new AssemblyError('chunk_sha256_mismatch');
      }
      out.sha256Hex = total.digest('hex');
    } catch (err) {
      if (err instanceof AssemblyError) out.failure = err;
      throw err;
    }
  }
  return Readable.from(gen(), { objectMode: false });
}

/**
 * Worker handler for `process_recording_session`: assemble the chunks into the recording's source object, verify it,
 * delete the chunks, then run the normal scan and processing. Idempotent: a retry after a successful assembly
 * (source row uploaded with its sha256) skips straight to chunk cleanup + scan/processing. Verification failures
 * mark the session/file/recording failed and leave no source object; infra errors are rethrown so BullMQ retries
 * (and fail the session on the final attempt).
 */
export async function processSessionAssembly(
  job: unknown,
  deps: SessionAssemblyDeps,
  ctx: { isFinalAttempt: boolean } = { isFinalAttempt: true },
): Promise<SessionAssemblyOutcome> {
  if (!Value.Check(SessionAssemblyJob, job)) return { status: 'skipped', reason: 'invalid_job' };
  const { organizationId, subjectId: sessionId } = job;
  const s = await deps.store.load(organizationId, sessionId);
  if (!s) return { status: 'skipped', reason: 'not_found' };
  if (s.status === 'failed') return { status: 'skipped', reason: 'already_failed' };
  if (s.status !== 'completed' || !s.recordingId || !s.file) {
    return { status: 'skipped', reason: 'not_completed' };
  }
  if (job.meetingId !== undefined && job.meetingId !== s.meetingId) {
    return { status: 'skipped', reason: 'not_found' };
  }
  const session = { ...s, recordingId: s.recordingId, file: s.file };
  const objects = deps.objects(session);
  const fail = async (code: AssemblyFailureCode): Promise<SessionAssemblyOutcome> => {
    await objects.deleteSource().catch(() => undefined);
    await deps.store.markFailed(organizationId, {
      sessionId,
      fileObjectId: session.file.id,
      recordingId: session.recordingId,
      code,
    });
    return { status: 'failed', code };
  };

  let sizeBytes: number;
  let sha256Hex: string;
  const assembled = session.file.status !== 'pending_upload' && session.file.checksumSha256Hex !== null;
  if (assembled) {
    // Retry after a verified assembly: never re-read chunks that may already be deleted.
    const head = await objects.headSource();
    if (!head) return fail('assembly_unavailable');
    sizeBytes = head.sizeBytes;
    sha256Hex = session.file.checksumSha256Hex!;
  } else {
    const ext = deps.sourceExt(session.mimeType);
    if (!ext) return fail('unsupported_mime');
    let total: number;
    try {
      total = checkChunkSet(session, deps.maxSourceBytes);
    } catch (err) {
      if (err instanceof AssemblyError) return fail(err.code);
      throw err;
    }
    const out: { sha256Hex?: string; failure?: AssemblyError } = {};
    try {
      await objects.putSource(concatenateChunks(session.chunks, objects.readChunk, out), {
        sizeBytes: total,
        mimeType: session.mimeType,
      });
    } catch (err) {
      if (out.failure) return fail(out.failure.code);
      if (err instanceof AssemblyError) return fail(err.code);
      await objects.deleteSource().catch(() => undefined);
      if (ctx.isFinalAttempt) return fail('assembly_unavailable');
      throw err;
    }
    if (out.failure) return fail(out.failure.code);
    const head = await objects.headSource();
    if (!head || head.sizeBytes !== total || !out.sha256Hex) return fail('total_size_mismatch');
    sizeBytes = total;
    sha256Hex = out.sha256Hex;
    await deps.store.markAssembled(organizationId, {
      sessionId,
      fileObjectId: session.file.id,
      recordingId: session.recordingId,
      sizeBytes,
      sha256Hex,
    });
  }
  // Only after the assembled source is verified and recorded.
  for (const c of session.chunks) await objects.deleteChunk(c);

  let verdict: 'clean' | 'quarantined';
  if (session.file.scanStatus === 'clean' || session.file.scanStatus === 'quarantined') {
    verdict = session.file.scanStatus;
  } else if (session.file.scanStatus === 'rejected') {
    verdict = 'quarantined';
  } else {
    try {
      verdict = await deps.scan(
        { size: async () => sizeBytes, body: () => objects.sourceBody() },
        session.mimeType,
      );
    } catch (err) {
      // Scanner/storage outage: retry; once attempts are exhausted quarantine (never left pending forever).
      if (!ctx.isFinalAttempt) throw err;
      verdict = 'quarantined';
    }
    await deps.store.setScanStatus(organizationId, session.file.id, verdict);
  }
  if (verdict !== 'clean') return { status: 'quarantined', sizeBytes, sha256Hex };
  const ext = deps.sourceExt(session.mimeType)!;
  await deps.process(
    {
      jobVersion: 1,
      kind: 'process_recording',
      organizationId,
      meetingId: session.meetingId,
      recordingId: session.recordingId,
      sourceExt: ext,
      sourceKey: session.file.key,
    } as MediaJobPayload,
    ctx,
  );
  return { status: 'processed', sizeBytes, sha256Hex };
}
