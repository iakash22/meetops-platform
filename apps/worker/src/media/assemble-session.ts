import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Value } from '@sinclair/typebox/value';
import {
  AssembleRecordingSessionJobPayload,
  MAX_RECORDING_SESSION_BYTES,
  MEDIA_JOB_NAMES,
  type MediaJobPayload,
  type MeetingProcessingFailedPayload,
} from '@meetops/contracts';
import type {
  GetObjectResult,
  MeetingObjectRef,
  PutObjectBody,
  StoredObjectInfo,
  UploadSpec,
} from '@meetops/storage';
import { mediaJobId, uuidV5 } from './ids.js';
import type { MinimalLogger, RealtimePublisher } from './processor.js';

/** One uploaded part of a completed session, as signed and recorded by the API (sha256 = lowercase hex). */
export type AssemblyChunk = { seq: number; sizeBytes: number; sha256: string };

export type AssemblySession = {
  meetingId: string;
  status: 'uploading' | 'completed' | 'aborted' | 'failed' | string;
  mimeType: string;
  chunkCount: number | null;
  chunks: AssemblyChunk[];
  /**
   * Set once the assembled source was verified and recorded (recordAssembled). Its presence is what makes a retry
   * skip the concatenation.
   */
  assembled: { recordingId: string; sizeBytes: number; sha256: string } | null;
};

export type AssembledRecording = {
  organizationId: string;
  meetingId: string;
  sessionId: string;
  recordingId: string;
  fileObjectId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  target: MeetingObjectRef;
};

/** Org-scoped persistence (forced RLS, runWithOrganizationContext). */
export type SessionAssemblyStore = {
  loadSession(organizationId: string, sessionId: string): Promise<AssemblySession | null>;
  /** Idempotent: upserts the source FileObject + Recording rows and links recording_sessions.recording_id. */
  recordAssembled(r: AssembledRecording): Promise<void>;
  /** Writes the ADR-013 `meeting.processing_failed` outbox row (same transaction scope as any status change). */
  recordProcessingFailed(p: MeetingProcessingFailedPayload): Promise<void>;
};

export type AssemblyStorage = {
  getObject(ref: MeetingObjectRef): Promise<GetObjectResult>;
  headObject(ref: MeetingObjectRef): Promise<StoredObjectInfo | null>;
  putObject(ref: MeetingObjectRef, body: PutObjectBody, spec: UploadSpec): Promise<unknown>;
  deleteObject(ref: MeetingObjectRef): Promise<void>;
};

export type RecordingEnqueuer = {
  /** Idempotent on opts.jobId (BullMQ ignores a duplicate id). */
  add(name: string, data: MediaJobPayload, opts: { jobId: string }): Promise<unknown>;
};

export type SessionAssemblyDeps = {
  store: SessionAssemblyStore;
  storage: AssemblyStorage;
  mediaQueue: RecordingEnqueuer;
  realtime?: Pick<RealtimePublisher, 'meetingStatus'>;
  logger: MinimalLogger;
  /** Total byte cap, enforced while streaming. Defaults to MAX_RECORDING_SESSION_BYTES (1.4e9). */
  maxBytes?: number;
  now?: () => Date;
};

export class AssemblyError extends Error {
  constructor(
    readonly code:
      | 'invalid_job'
      | 'session_not_ready'
      | 'assembly_cap_exceeded'
      | 'assembly_chunk_invalid'
      | 'assembly_checksum_mismatch'
      | 'assembly_verify_failed',
    message: string,
  ) {
    super(message);
    this.name = 'AssemblyError';
  }
}

/** Deterministic ids: every retry of a session writes the same recording, FileObject and object key. */
export const sessionRecordingId = (sessionId: string) => uuidV5(`session-recording:${sessionId}`);
export const sessionSourceFileObjectId = (sessionId: string) =>
  uuidV5(`session-source:${sessionId}`);

const chunkRef = (
  organizationId: string,
  meetingId: string,
  sessionId: string,
  seq: number,
): MeetingObjectRef => ({
  kind: 'session_chunk',
  organizationId,
  meetingId,
  objectId: sessionId,
  index: seq,
});

export type AssemblyResult = {
  status: 'assembled' | 'already_assembled';
  recordingId: string;
  sizeBytes: number;
  sha256: string;
};

/**
 * ADR-014: concatenate a completed session's chunks (in seq order) into the recording source object, then enqueue
 * `process_recording`. Streams chunk by chunk (never the whole recording in memory), verifies every chunk's size and
 * SHA-256 and the running total against the cap while streaming, then verifies the written object (size + SHA-256
 * read-back) before recording it and only then deleting the chunks. Any failure leaves every chunk in place.
 */
export async function assembleRecordingSession(
  input: unknown,
  deps: SessionAssemblyDeps,
  ctx: { isFinalAttempt: boolean } = { isFinalAttempt: true },
): Promise<AssemblyResult> {
  if (!Value.Check(AssembleRecordingSessionJobPayload, input))
    throw new AssemblyError('invalid_job', 'Invalid assemble_recording_session job');
  const job = input;
  const { organizationId, meetingId, sessionId } = job;
  const now = deps.now ?? (() => new Date());
  const log = { organizationId, meetingId, sessionId };
  try {
    const session = await deps.store.loadSession(organizationId, sessionId);
    if (!session || session.meetingId !== meetingId || session.status !== 'completed')
      throw new AssemblyError('session_not_ready', 'Recording session is not completed');
    const recordingId = session.assembled?.recordingId ?? sessionRecordingId(sessionId);
    const target: MeetingObjectRef = {
      kind: 'recording',
      organizationId,
      meetingId,
      objectId: recordingId,
      ext: job.sourceExt,
    };
    let result: AssemblyResult;
    const head = session.assembled ? await deps.storage.headObject(target) : null;
    if (session.assembled && head?.sizeBytes === session.assembled.sizeBytes) {
      // Verified and recorded by an earlier attempt: only the post-steps (delete, enqueue) may be missing.
      result = { ...session.assembled, status: 'already_assembled', recordingId };
    } else {
      const chunks = orderedChunks(session);
      const { sizeBytes, sha256 } = await concatenate(deps, job, session, chunks, target);
      await deps.store.recordAssembled({
        organizationId,
        meetingId,
        sessionId,
        recordingId,
        fileObjectId: sessionSourceFileObjectId(sessionId),
        mimeType: baseMime(session.mimeType),
        sizeBytes,
        sha256,
        target,
      });
      result = { status: 'assembled', recordingId, sizeBytes, sha256 };
    }
    // Only now (assembled object verified + recorded) are the chunks redundant. Deleting a missing chunk is a no-op.
    for (const c of session.chunks)
      await deps.storage.deleteObject(chunkRef(organizationId, meetingId, sessionId, c.seq));
    const next: MediaJobPayload = {
      jobVersion: 1,
      kind: MEDIA_JOB_NAMES.processRecording,
      organizationId,
      meetingId,
      recordingId,
      sourceExt: job.sourceExt,
    };
    await deps.mediaQueue.add(MEDIA_JOB_NAMES.processRecording, next, {
      jobId: mediaJobId(organizationId, recordingId),
    });
    deps.logger.info({ ...log, recordingId, status: result.status }, 'recording session assembled');
    return result;
  } catch (err) {
    const errorCode = err instanceof AssemblyError ? err.code : 'assembly_failed';
    deps.logger.error(
      { ...log, errorCode, finalAttempt: ctx.isFinalAttempt },
      'session assembly failed',
    );
    if (ctx.isFinalAttempt) {
      const at = now().toISOString();
      await deps.store.recordProcessingFailed({
        organizationId,
        meetingId,
        subjectType: 'recording_session',
        subjectId: sessionId,
        errorCode,
        failedAt: at,
      });
      deps.realtime?.meetingStatus({ organizationId, meetingId, status: 'failed', errorCode, at });
    }
    throw err;
  }
}

const baseMime = (m: string) => m.split(';')[0]!.trim().toLowerCase();

function orderedChunks(session: AssemblySession): AssemblyChunk[] {
  const chunks = [...session.chunks].sort((a, b) => a.seq - b.seq);
  if (chunks.length === 0 || (session.chunkCount !== null && session.chunkCount !== chunks.length))
    throw new AssemblyError('assembly_chunk_invalid', 'Chunk count does not match the session');
  chunks.forEach((c, i) => {
    if (c.seq !== i || !/^[0-9a-f]{64}$/.test(c.sha256) || !(c.sizeBytes > 0))
      throw new AssemblyError('assembly_chunk_invalid', `Chunk ${i} is missing or has no checksum`);
  });
  return chunks;
}

async function concatenate(
  deps: SessionAssemblyDeps,
  job: AssembleRecordingSessionJobPayload,
  session: AssemblySession,
  chunks: AssemblyChunk[],
  target: MeetingObjectRef,
): Promise<{ sizeBytes: number; sha256: string }> {
  const { organizationId, meetingId, sessionId } = job;
  const cap = deps.maxBytes ?? MAX_RECORDING_SESSION_BYTES;
  const declared = chunks.reduce((n, c) => n + c.sizeBytes, 0);
  if (declared > cap)
    throw new AssemblyError('assembly_cap_exceeded', `Recording exceeds ${cap} bytes`);
  const whole = createHash('sha256');
  let failure: AssemblyError | undefined;
  const fail = (e: AssemblyError) => {
    failure = e;
    return e;
  };
  async function* body() {
    let total = 0;
    for (const c of chunks) {
      const { body: src } = await deps.storage.getObject(
        chunkRef(organizationId, meetingId, sessionId, c.seq),
      );
      const part = createHash('sha256');
      let n = 0;
      try {
        for await (const raw of src) {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          n += buf.length;
          total += buf.length;
          // Abort as soon as either cap is crossed: the stored part may be bigger than the signed size.
          if (total > cap)
            throw fail(
              new AssemblyError('assembly_cap_exceeded', `Recording exceeds ${cap} bytes`),
            );
          if (n > c.sizeBytes)
            throw fail(
              new AssemblyError(
                'assembly_checksum_mismatch',
                `Chunk ${c.seq} is larger than signed`,
              ),
            );
          part.update(buf);
          whole.update(buf);
          yield buf;
        }
      } finally {
        src.destroy();
      }
      if (n !== c.sizeBytes || part.digest('hex') !== c.sha256)
        throw fail(
          new AssemblyError('assembly_checksum_mismatch', `Chunk ${c.seq} checksum mismatch`),
        );
    }
  }
  try {
    await deps.storage.putObject(target, Readable.from(body()), {
      mimeType: baseMime(session.mimeType),
      sizeBytes: declared,
    });
  } catch (err) {
    // A failed streamed PUT stores nothing, but clear the deterministic key in case a store kept a partial object.
    await deps.storage.deleteObject(target).catch(() => undefined);
    throw failure ?? err;
  }
  if (failure) {
    await deps.storage.deleteObject(target).catch(() => undefined);
    throw failure;
  }
  const sha256 = whole.digest('hex');
  await verifyAssembled(deps.storage, target, declared, sha256);
  return { sizeBytes: declared, sha256 };
}

/** Size (HEAD) + SHA-256 read-back of the written object; a mismatch deletes it (never the chunks). */
async function verifyAssembled(
  storage: AssemblyStorage,
  target: MeetingObjectRef,
  sizeBytes: number,
  sha256: string,
): Promise<void> {
  const bad = async (msg: string) => {
    await storage.deleteObject(target).catch(() => undefined);
    return new AssemblyError('assembly_verify_failed', msg);
  };
  const head = await storage.headObject(target);
  if (!head || head.sizeBytes !== sizeBytes) throw await bad('Assembled size mismatch');
  const { body } = await storage.getObject(target);
  const h = createHash('sha256');
  for await (const raw of body)
    h.update(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array));
  if (h.digest('hex') !== sha256) throw await bad('Assembled checksum mismatch');
}
