import type { Readable } from 'node:stream';
import { withOrganizationContext, type MediaRepositoryOptions } from '@meetops/database';
import {
  buildObjectKey,
  sourceExtForMime,
  type MeetingObjectRef,
  type S3SessionChunkStore,
  type S3StorageService,
} from '@meetops/storage';
import type {
  AssemblyChunk,
  AssemblySession,
  SessionAssemblyStore,
  SessionObjects,
} from './session-assembly.js';

/** Prisma-backed SessionAssemblyStore; every statement runs under withOrganizationContext (forced RLS). */
export function createSessionAssemblyStore(opts: MediaRepositoryOptions = {}): SessionAssemblyStore {
  const o = {
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return {
    load: (organizationId, sessionId) =>
      withOrganizationContext(
        organizationId,
        async (tx): Promise<AssemblySession | null> => {
          const s = await tx.recordingSession.findFirst({
            where: { organizationId, id: sessionId },
            select: {
              id: true,
              organizationId: true,
              meetingId: true,
              status: true,
              chunkCount: true,
              totalBytes: true,
              mimeType: true,
              recordingId: true,
              recording: {
                select: {
                  file: {
                    select: { id: true, key: true, status: true, checksumSha256: true, scanStatus: true },
                  },
                },
              },
              chunks: {
                orderBy: { seq: 'asc' },
                select: { seq: true, sizeBytes: true, sha256: true, storageKey: true },
              },
            },
          });
          if (!s) return null;
          const f = s.recording?.file ?? null;
          return {
            id: s.id,
            organizationId: s.organizationId,
            meetingId: s.meetingId,
            status: s.status,
            chunkCount: s.chunkCount,
            totalBytes: Number(s.totalBytes),
            mimeType: s.mimeType,
            recordingId: s.recordingId,
            file: f
              ? {
                  id: f.id,
                  key: f.key,
                  status: f.status,
                  checksumSha256Hex: f.checksumSha256,
                  scanStatus: f.scanStatus,
                }
              : null,
            chunks: s.chunks.map((c) => ({
              seq: c.seq,
              sizeBytes: c.sizeBytes,
              sha256Hex: c.sha256 ?? '',
              key: c.storageKey,
            })),
          };
        },
        o,
      ),
    markAssembled: async (organizationId, a) => {
      await withOrganizationContext(
        organizationId,
        async (tx) => {
          await tx.fileObject.updateMany({
            where: { organizationId, id: a.fileObjectId, status: 'pending_upload' },
            data: { status: 'uploaded', sizeBytes: BigInt(a.sizeBytes), checksumSha256: a.sha256Hex },
          });
          await tx.recording.updateMany({
            where: { organizationId, id: a.recordingId, status: 'uploading' },
            data: { status: 'uploaded' },
          });
        },
        o,
      );
    },
    markFailed: async (organizationId, f) => {
      await withOrganizationContext(
        organizationId,
        async (tx) => {
          await tx.recordingSession.updateMany({
            where: { organizationId, id: f.sessionId },
            data: { status: 'failed', failureCode: f.code },
          });
          if (f.fileObjectId) {
            await tx.fileObject.updateMany({
              where: { organizationId, id: f.fileObjectId },
              data: { status: 'failed' },
            });
          }
          if (f.recordingId) {
            await tx.recording.updateMany({
              where: { organizationId, id: f.recordingId },
              data: { status: 'failed' },
            });
          }
        },
        o,
      );
    },
    setScanStatus: async (organizationId, fileObjectId, status) => {
      await withOrganizationContext(
        organizationId,
        (tx) =>
          tx.fileObject.updateMany({
            where: { organizationId, id: fileObjectId, scanStatus: 'pending' },
            data: { scanStatus: status },
          }),
        o,
      );
    },
  };
}

/**
 * SessionObjects over S3: chunks through S3SessionChunkStore (bound to the session), the source through
 * S3StorageService under the recording's meeting ref (the caller runs this inside runInJobScope).
 */
export function sessionObjectsFromStorage(
  storage: Pick<S3StorageService, 'putObject' | 'headObject' | 'deleteObject' | 'getObject'>,
  chunks: Pick<S3SessionChunkStore, 'readChunk' | 'deleteChunk'>,
  s: { organizationId: string; meetingId: string; id: string; recordingId: string; mimeType: string; file: { key: string } },
): SessionObjects {
  const ext = sourceExtForMime(s.mimeType);
  const ref: MeetingObjectRef | null = ext
    ? { organizationId: s.organizationId, meetingId: s.meetingId, kind: 'recording', objectId: s.recordingId, ext }
    : null;
  const target = () => {
    // The row's key must be the canonical source key: never write anywhere else.
    if (!ref || buildObjectKey(ref) !== s.file.key) throw new Error('Session source key mismatch');
    return ref;
  };
  return {
    readChunk: (c: AssemblyChunk) => chunks.readChunk(s.organizationId, s.id, c.key),
    deleteChunk: (c: AssemblyChunk) => chunks.deleteChunk(s.organizationId, s.id, c.key),
    putSource: async (body: Readable, spec) => {
      await storage.putObject(target(), body, { mimeType: spec.mimeType, sizeBytes: spec.sizeBytes });
    },
    headSource: async () => {
      const h = await storage.headObject(target());
      return h ? { sizeBytes: h.sizeBytes } : null;
    },
    deleteSource: () => storage.deleteObject(target()),
    sourceBody: async () => (await storage.getObject(target())).body,
  };
}
