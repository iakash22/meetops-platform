import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  CONSENT_ATTESTATION_MAX_SKEW_SECONDS,
  CURRENT_CONSENT_VERSION,
  MAX_RECORDING_SESSION_BYTES,
  type MediaJobPayload,
} from '@meetops/contracts';
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
/** Latest stored consent attestation for the session (append-only table; newest wins, as in the API). */
export type AssemblyConsent = {
  id: string;
  consentVersion: string;
  attestedAt: Date;
  recordedAt: Date;
};

export type AssemblySession = {
  id: string;
  /**
   * #303 M-1: the first soft-deleted parent (null when all are live). Loaded with the session so a deletion after
   * complete stops assembly instead of re-materializing the media.
   */
  deleted?: 'organization' | 'meeting' | 'recording' | 'file' | null;
  /** #303 M-1: latest consent for (org, 'recording_session', session); null when none. */
  consent?: AssemblyConsent | null;
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
  load: (organizationId: string, sessionId: string) => Promise<AssemblySession | null>;
  /** Source FileObject -> uploaded (size + final sha256), recording -> uploaded. One transaction. */
  markAssembled: (
    organizationId: string,
    s: {
      sessionId: string;
      fileObjectId: string;
      recordingId: string;
      sizeBytes: number;
      sha256Hex: string;
    },
  ) => Promise<void>;
  /** Session -> failed (failure_code), source FileObject + recording -> failed. One transaction. */
  markFailed: (
    organizationId: string,
    s: {
      sessionId: string;
      fileObjectId: string | null;
      recordingId: string | null;
      code: AssemblyFailureCode;
    },
  ) => Promise<void>;
  /** Sets scanStatus only while it is still pending (idempotent). */
  setScanStatus: (
    organizationId: string,
    fileObjectId: string,
    status: 'clean' | 'quarantined',
  ) => Promise<void>;
};

/** Object access for one session; implementations bind keys to the job's org + meeting/session. */
export type SessionObjects = {
  readChunk: (chunk: AssemblyChunk) => Promise<Readable>;
  deleteChunk: (chunk: AssemblyChunk) => Promise<void>;
  /** Single PUT of the assembled source (atomic: a failed body stream stores nothing). */
  putSource: (body: Readable, spec: { sizeBytes: number; mimeType: string }) => Promise<void>;
  headSource: () => Promise<{ sizeBytes: number } | null>;
  deleteSource: () => Promise<void>;
  sourceBody: () => Promise<Readable>;
};

export type AssemblyFailureCode =
  | 'chunk_set_invalid'
  | 'chunk_missing'
  | 'chunk_size_mismatch'
  | 'chunk_sha256_mismatch'
  | 'total_size_mismatch'
  | 'size_cap_exceeded'
  | 'unsupported_mime'
  | 'assembly_unavailable'
  | 'consent_invalid';

export class AssemblyError extends Error {
  constructor(readonly code: AssemblyFailureCode) {
    super(code);
    this.name = 'AssemblyError';
  }
}

export type SessionAssemblyDeps = {
  store: SessionAssemblyStore;
  objects: (
    s: AssemblySession & { recordingId: string; file: NonNullable<AssemblySession['file']> },
  ) => SessionObjects;
  /** Hard cap on the assembled source (worker MEDIA_MAX_SOURCE_BYTES), never above MAX_RECORDING_SESSION_BYTES. */
  maxSourceBytes: number;
  /** The normal content scan (magic bytes, ffprobe, optional clamd) on the assembled source. */
  scan: (
    source: { size: () => Promise<number | null>; body: () => Promise<Readable> },
    mimeType: string,
  ) => Promise<'clean' | 'quarantined'>;
  /** The normal recording pipeline (processRecording) for a clean source. */
  process: (payload: MediaJobPayload, ctx: { isFinalAttempt: boolean }) => Promise<unknown>;
  sourceExt: (mimeType: string) => MediaJobPayload['sourceExt'] | null;
};

export type SessionAssemblyOutcome =
  | {
      status: 'skipped';
      reason:
        | 'invalid_job'
        | 'not_found'
        | 'not_completed'
        | 'already_failed'
        | 'deleted'
        | 'consent_invalid'
        | 'consent_mismatch';
    }
  | { status: 'failed'; code: AssemblyFailureCode }
  | { status: 'quarantined'; sizeBytes: number; sha256Hex: string }
  | { status: 'processed'; sizeBytes: number; sha256Hex: string };

/** Ordered, contiguous 0..n-1 chunk set whose sizes add up to the session total and fit the cap. */
export function checkChunkSet(s: AssemblySession, maxSourceBytes: number): number {
  const n = s.chunkCount ?? 0;
  if (n < 1 || s.chunks.length !== n)
    throw new AssemblyError(s.chunks.length < n ? 'chunk_missing' : 'chunk_set_invalid');
  let total = 0;
  s.chunks.forEach((c, i) => {
    if (c.seq !== i || !/^[0-9a-f]{64}$/.test(c.sha256Hex) || c.sizeBytes < 1) {
      throw new AssemblyError(c.seq > i ? 'chunk_missing' : 'chunk_set_invalid');
    }
    total += c.sizeBytes;
  });
  if (total !== s.totalBytes) throw new AssemblyError('total_size_mismatch');
  if (total > Math.min(maxSourceBytes, MAX_RECORDING_SESSION_BYTES))
    throw new AssemblyError('size_cap_exceeded');
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
        // #303 M-3: a late error from an abandoned chunk stream must never become an unhandled 'error' event.
        body.on('error', noop);
        const h = createHash('sha256');
        let n = 0;
        try {
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
        } finally {
          if (!body.destroyed) body.destroy();
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
  const stream = Readable.from(gen(), { objectMode: false });
  // #303 M-3: the S3 SDK detaches its listeners once the request fails, so the generator's error would otherwise be
  // re-emitted with no listener and crash the worker. The failure still reaches the caller via `out` / putSource.
  stream.on('error', noop);
  return stream;
}

const noop = () => undefined;

/**
 * #303 M-3: runs `put` with `body`, rejecting as soon as the body stream errors (the SDK may otherwise wait for a
 * body that will never end). The body is destroyed on any failure; the losing promise is always observed.
 */
export async function putWithBody(
  body: Readable,
  put: (b: Readable) => Promise<void>,
): Promise<void> {
  body.on('error', noop);
  let onError: (e: unknown) => void = noop;
  const failed = new Promise<never>((_, reject) => {
    onError = reject;
    body.once('error', onError);
  });
  const p = put(body);
  p.catch(noop);
  failed.catch(noop);
  try {
    await Promise.race([p, failed]);
  } catch (err) {
    if (!body.destroyed) body.destroy();
    throw err;
  } finally {
    body.off('error', onError);
  }
}

/**
 * Worker handler for `process_recording_session`: assemble the chunks into the recording's source object, verify it,
 * delete the chunks, then run the normal scan and processing. Idempotent: a retry after a successful assembly
 * (source row uploaded with its sha256) skips straight to chunk cleanup + scan/processing. Verification failures
 * mark the session/file/recording failed and leave no source object; infra errors are rethrown so BullMQ retries
 * (and fail the session on the final attempt).
 */
/** The job's attestation must be the latest stored one for the session and itself valid. */
export function consentMatches(c: AssemblyConsent | null, consentAttestationId: string): boolean {
  if (!c || c.id !== consentAttestationId) return false;
  if (c.consentVersion !== CURRENT_CONSENT_VERSION) return false;
  return (
    c.attestedAt.getTime() <= c.recordedAt.getTime() + CONSENT_ATTESTATION_MAX_SKEW_SECONDS * 1000
  );
}

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
  /** #303 L-1 / M-1: chunks live outside the lifecycle-expiring tmp prefix, so terminal outcomes reclaim them. */
  const reclaimChunks = async () => {
    for (const c of session.chunks) await objects.deleteChunk(c).catch(() => undefined);
  };
  // #303 M-1: never assemble media whose org/meeting/recording/file was deleted after complete, or whose job does
  // not carry the session's current valid consent (same rule as the API's checkStoredConsent / the backfill).
  if (s.deleted) {
    await reclaimChunks();
    return { status: 'skipped', reason: 'deleted' };
  }
  const consent = s.consent ?? null;
  if (!consentMatches(consent, job.consentAttestationId)) {
    if (consent && consentMatches(consent, consent.id)) {
      // #303 L-4: the session HAS a valid consent, the job just carries a stale/other id: leave everything intact
      // (the backfill / a replay re-queues it with the right one).
      return { status: 'skipped', reason: 'consent_mismatch' };
    }
    // No valid stored consent at all: reclaim and fail the rows so the backfill never re-picks the session.
    await reclaimChunks();
    await deps.store.markFailed(organizationId, {
      sessionId,
      fileObjectId: session.file.id,
      recordingId: session.recordingId,
      code: 'consent_invalid',
    });
    return { status: 'skipped', reason: 'consent_invalid' };
  }
  const fail = async (code: AssemblyFailureCode): Promise<SessionAssemblyOutcome> => {
    await objects.deleteSource().catch(() => undefined);
    await reclaimChunks();
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
  const assembled =
    session.file.status !== 'pending_upload' && session.file.checksumSha256Hex !== null;
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
    },
    ctx,
  );
  return { status: 'processed', sizeBytes, sha256Hex };
}
