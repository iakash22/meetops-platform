/**
 * Media worker persistence ports (PR #92, head 4100d22). Types mirror, structurally, the interfaces Media defines in
 * apps/worker/src/media/processor.ts (ChunkFileObjectRow, ChunkFileObjectRepository, RecordingChunkCountRepository)
 * and packages/storage/src/audio-resolver.ts (ChunkFileObjectRecord, ChunkFileObjectLookup). They are redeclared
 * here because @meetops/database must not depend on apps/worker; TypeScript's structural typing lets the
 * implementations be passed straight into MediaProcessorDeps / createChunkAudioResolver.
 *
 * Every method runs inside withOrganizationContext(organizationId), so forced RLS scopes it.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
// Circular import is safe: getPrismaClient is only called at request time, after both modules load.
import { getPrismaClient } from './index.js';
import { runWithOrganizationContext, type TransactionCapableClient } from './tenant.js';

/** One chunk FileObject row (file_objects, kind = chunk). Mirrors #92 ChunkFileObjectRow. */
export type ChunkFileObjectRow = {
  /** Deterministic uuidv5 of chunk:{recordingId}:{index}. Idempotency key. */
  fileObjectId: string;
  index: number;
  storageKey: string;
  sizeBytes: number;
  mimeType: 'audio/wav';
  /** Lowercase hex sha256 (64 chars). */
  sha256?: string;
  startMs: number;
  durationMs: number;
};

export type ChunkFileObjectRepository = {
  upsertChunkFileObjects(q: {
    organizationId: string;
    meetingId: string;
    recordingId: string;
    chunks: ChunkFileObjectRow[];
  }): Promise<void>;
};

export type RecordingChunkCountRepository = {
  setChunkCount(q: {
    organizationId: string;
    meetingId: string;
    recordingId: string;
    chunkCount: number;
  }): Promise<void>;
};

/** Mirrors #92 ChunkFileObjectRecord (packages/storage/src/audio-resolver.ts). */
export type ChunkFileObjectRecord = {
  id: string;
  organizationId: string;
  meetingId: string | null;
  kind: string;
  key: string;
  mimeType: string;
  sizeBytes?: number | bigint | null;
  chunkIndex?: number | null;
};

export interface ChunkFileObjectLookup {
  findFileObject(q: {
    organizationId: string;
    fileObjectId: string;
  }): Promise<ChunkFileObjectRecord | null>;
}

export interface MediaRepositoryOptions {
  /** Defaults to the shared singleton from getPrismaClient(). */
  client?: TransactionCapableClient | PrismaClient;
  timeoutMs?: number;
}

export interface ChunkFileObjectRepositoryOptions extends MediaRepositoryOptions {
  /** Bucket the worker stored the chunks in (not part of #92's row type). */
  bucket: string;
  /** Storage provider id; file_objects default is 's3'. */
  provider?: string;
}

/** Thrown when a chunk row would move to another organization/key, or a write affects no row. */
export class MediaPersistenceError extends Error {
  override readonly name = 'MediaPersistenceError';
  constructor(
    readonly code:
      | 'chunk_count_not_updated'
      | 'chunk_file_object_conflict'
      | 'invalid_chunk_row'
      | 'invalid_chunk_count',
    message: string,
  ) {
    super(message);
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
/** Upper bound of chunk count, same as recordings_chunk_count_check. */
export const MAX_RECORDING_CHUNKS = 10000;

/**
 * Structural check of a chunk key: organizations/{organizationId}/meetings/{meetingId}/processed/{recordingId}/chunks/{nnnnn}.wav
 * New writes must use the organizations/ prefix (ADR-010 phase A); legacy org/ keys are never written.
 */
function chunkKeyMatches(
  key: string,
  q: { organizationId: string; meetingId: string; recordingId: string },
  index: number,
): boolean {
  const m = new RegExp(
    `^organizations/(${SEGMENT})/meetings/(${SEGMENT})/processed/(${SEGMENT})/chunks/(\\d{5})\\.wav$`,
  ).exec(key);
  return (
    !!m &&
    m[1] === q.organizationId &&
    m[2] === q.meetingId &&
    m[3] === q.recordingId &&
    Number(m[4]) === index
  );
}

function runner(options: MediaRepositoryOptions) {
  return <T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
}

/** RecordingChunkCountRepository: sets recordings.chunk_count; throws if no row matched (org, meeting, id). */
export function createRecordingChunkCountRepository(
  options: MediaRepositoryOptions = {},
): RecordingChunkCountRepository {
  const run = runner(options);
  return {
    async setChunkCount({ organizationId, meetingId, recordingId, chunkCount }) {
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_RECORDING_CHUNKS) {
        throw new MediaPersistenceError(
          'invalid_chunk_count',
          'chunkCount must be an integer in 1..10000',
        );
      }
      const n = await run(
        organizationId,
        (tx) => tx.$executeRaw`
          UPDATE "recordings" SET "chunk_count" = ${chunkCount}, "updated_at" = now()
          WHERE "org_id" = ${organizationId}::uuid AND "id" = ${recordingId}::uuid
            AND "meeting_id" = ${meetingId}::uuid`,
      );
      if (n !== 1)
        throw new MediaPersistenceError('chunk_count_not_updated', 'Recording not found');
    },
  };
}

/**
 * ChunkFileObjectRepository: idempotent upsert of chunk FileObjects in one transaction. ON CONFLICT (id) only
 * refreshes size/checksum/timing, and only when the existing row has the same organization and key; otherwise the
 * whole call throws (and rolls back). Under RLS a row of another organization is not even updatable.
 */
export function createChunkFileObjectRepository(
  options: ChunkFileObjectRepositoryOptions,
): ChunkFileObjectRepository {
  if (!options?.bucket) throw new TypeError('bucket is required');
  const run = runner(options);
  const provider = options.provider ?? 's3';
  return {
    async upsertChunkFileObjects(q) {
      for (const c of q.chunks) {
        const ok =
          Number.isInteger(c.index) &&
          c.index >= 0 &&
          Number.isInteger(c.sizeBytes) &&
          c.sizeBytes >= 0 &&
          c.mimeType === 'audio/wav' &&
          (c.sha256 === undefined || SHA256_HEX.test(c.sha256)) &&
          Number.isFinite(c.startMs) &&
          c.startMs >= 0 &&
          Number.isFinite(c.durationMs) &&
          c.durationMs >= 0 &&
          chunkKeyMatches(c.storageKey, q, c.index);
        if (!ok)
          throw new MediaPersistenceError('invalid_chunk_row', `Invalid chunk row ${c.index}`);
      }
      await run(q.organizationId, async (tx) => {
        for (const c of q.chunks) {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "file_objects"
              ("id", "org_id", "meeting_id", "kind", "status", "provider", "bucket", "storage_key", "mime_type",
               "size_bytes", "checksum_sha256", "chunk_index", "start_seconds", "duration_seconds",
               "created_at", "updated_at")
            VALUES (${c.fileObjectId}::uuid, ${q.organizationId}::uuid, ${q.meetingId}::uuid, 'chunk', 'uploaded',
                    ${provider}, ${options.bucket}, ${c.storageKey}, ${c.mimeType}, ${c.sizeBytes}::bigint,
                    ${c.sha256 ?? null}, ${c.index}, ${c.startMs / 1000}::float8, ${c.durationMs / 1000}::float8,
                    now(), now())
            ON CONFLICT ("id") DO UPDATE SET
              "size_bytes" = EXCLUDED."size_bytes",
              "checksum_sha256" = EXCLUDED."checksum_sha256",
              "start_seconds" = EXCLUDED."start_seconds",
              "duration_seconds" = EXCLUDED."duration_seconds",
              "updated_at" = now()
            WHERE "file_objects"."org_id" = EXCLUDED."org_id"
              AND "file_objects"."storage_key" = EXCLUDED."storage_key"
              AND "file_objects"."kind" = 'chunk'
            RETURNING "id"`;
          if (rows.length !== 1) {
            throw new MediaPersistenceError(
              'chunk_file_object_conflict',
              `Chunk FileObject ${c.index} exists with a different organization, key or kind`,
            );
          }
        }
      });
    },
  };
}

/** ChunkFileObjectLookup: one FileObject by id, RLS-scoped to organizationId. Returns null when not visible. */
export function createChunkFileObjectLookup(
  options: MediaRepositoryOptions = {},
): ChunkFileObjectLookup {
  const run = runner(options);
  return {
    findFileObject({ organizationId, fileObjectId }) {
      return run(organizationId, async (tx) => {
        const row = await tx.fileObject.findFirst({
          where: { id: fileObjectId, organizationId, deletedAt: null },
          select: {
            id: true,
            organizationId: true,
            meetingId: true,
            kind: true,
            key: true,
            mimeType: true,
            sizeBytes: true,
            chunkIndex: true,
          },
        });
        return row ?? null;
      });
    },
  };
}
