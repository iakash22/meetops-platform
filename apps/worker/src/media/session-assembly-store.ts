import {
  withOrganizationContext,
  type DatabaseTransaction,
  type MediaRepositoryOptions,
} from '@meetops/database';
import { buildObjectKey } from '@meetops/storage';
import {
  MEETING_PROCESSING_FAILED_EVENT,
  type MeetingProcessingFailedPayload,
} from '@meetops/contracts';
import type { AssemblySession, SessionAssemblyStore } from './assemble-session.js';

type Run = <T>(organizationId: string, fn: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>;

export type SessionAssemblyStoreOptions = MediaRepositoryOptions & {
  bucket: string;
  provider?: string;
};

/** Outbox writer for `meeting.processing_failed` (ADR-013); also used by processRecording's final failure. */
export type ProcessingFailureOutbox = Pick<SessionAssemblyStore, 'recordProcessingFailed'>;

/**
 * Prisma-backed SessionAssemblyStore. Every statement runs inside runWithOrganizationContext(organizationId), so
 * forced RLS scopes reads and writes to the job's organization.
 */
export function createSessionAssemblyStore(
  opts: SessionAssemblyStoreOptions,
): SessionAssemblyStore {
  if (!opts?.bucket) throw new TypeError('bucket is required');
  const run: Run = (organizationId, fn) =>
    withOrganizationContext(organizationId, fn, {
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  return {
    loadSession: (organizationId, sessionId) =>
      run(organizationId, async (tx): Promise<AssemblySession | null> => {
        const s = await tx.recordingSession.findFirst({
          where: { id: sessionId, organizationId },
          select: {
            meetingId: true,
            status: true,
            mimeType: true,
            chunkCount: true,
            recordingId: true,
            chunks: {
              select: { seq: true, sizeBytes: true, sha256: true },
              orderBy: { seq: 'asc' },
            },
            recording: { select: { file: { select: { sizeBytes: true, checksumSha256: true } } } },
          },
        });
        if (!s) return null;
        const f = s.recording?.file;
        return {
          meetingId: s.meetingId,
          status: s.status,
          mimeType: s.mimeType,
          chunkCount: s.chunkCount,
          chunks: s.chunks.map((c) => ({
            seq: c.seq,
            sizeBytes: c.sizeBytes,
            sha256: (c.sha256 ?? '').toLowerCase(),
          })),
          assembled:
            s.recordingId && f?.sizeBytes != null && f.checksumSha256
              ? {
                  recordingId: s.recordingId,
                  sizeBytes: Number(f.sizeBytes),
                  sha256: f.checksumSha256,
                }
              : null,
        };
      }),
    recordAssembled: (r) =>
      run(r.organizationId, async (tx) => {
        const key = buildObjectKey(r.target);
        const file = {
          meetingId: r.meetingId,
          kind: 'raw' as const,
          status: 'uploaded' as const,
          provider: opts.provider ?? 's3',
          bucket: opts.bucket,
          key,
          mimeType: r.mimeType,
          sizeBytes: BigInt(r.sizeBytes),
          checksumSha256: r.sha256,
        };
        await tx.fileObject.upsert({
          where: { id: r.fileObjectId },
          create: { id: r.fileObjectId, organizationId: r.organizationId, ...file },
          update: file,
        });
        await tx.recording.upsert({
          where: { id: r.recordingId },
          create: {
            id: r.recordingId,
            organizationId: r.organizationId,
            meetingId: r.meetingId,
            fileObjectId: r.fileObjectId,
            status: 'uploaded',
          },
          update: {},
        });
        const linked = await tx.recordingSession.updateMany({
          where: { id: r.sessionId, organizationId: r.organizationId, status: 'completed' },
          data: { recordingId: r.recordingId },
        });
        if (linked.count !== 1) throw new Error('Recording session is not completed');
      }),
    recordProcessingFailed: (p) => writeProcessingFailed(run, p),
  };
}

function writeProcessingFailed(run: Run, p: MeetingProcessingFailedPayload): Promise<void> {
  return run(p.organizationId, async (tx) => {
    await tx.outboxEvent.create({
      data: {
        organizationId: p.organizationId,
        aggregateType: 'meeting',
        aggregateId: p.meetingId,
        eventType: MEETING_PROCESSING_FAILED_EVENT,
        payload: p,
      },
    });
  });
}

/** Standalone `meeting.processing_failed` outbox writer (processRecording's terminal failure). */
export function createProcessingFailureOutbox(
  opts: MediaRepositoryOptions = {},
): ProcessingFailureOutbox {
  const run: Run = (organizationId, fn) =>
    withOrganizationContext(organizationId, fn, {
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  return { recordProcessingFailed: (p) => writeProcessingFailed(run, p) };
}
