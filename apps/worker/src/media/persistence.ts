import {
  createChunkFileObjectLookup,
  createChunkFileObjectRepository,
  createRecordingChunkCountRepository,
  type ChunkFileObjectLookup,
  type MediaRepositoryOptions,
} from '@meetops/database';
import { createChunkAudioResolver, type ChunkAudioResolverDeps } from '@meetops/storage';
import type { ChunkFileObjectRepository, RecordingChunkCountRepository } from './processor.js';

export type MediaPersistenceOptions = MediaRepositoryOptions & {
  /** Bucket the chunks are stored in (STORAGE_BUCKET), recorded on each chunk FileObject row. */
  bucket: string;
  /** Storage provider id recorded on the row (minio | r2 | s3). file_objects defaults to 's3'. */
  provider?: string;
};

/**
 * The #92 persistence steps of the media pipeline, backed by @meetops/database. Every method runs its SQL inside
 * runWithOrganizationContext(organizationId), so forced Postgres RLS (app.current_organization_id) scopes each
 * write to the job's organization; nothing is written outside that context.
 */
export type MediaPersistence = {
  /** Upserts chunk FileObject rows (file_objects, kind = chunk). */
  chunkFileObjects: ChunkFileObjectRepository;
  /** Sets recordings.chunk_count. */
  recordings: RecordingChunkCountRepository;
  /** RLS-scoped chunk FileObject lookup for the audio resolver. */
  chunkLookup: ChunkFileObjectLookup;
};

export function createMediaPersistence(opts: MediaPersistenceOptions): MediaPersistence {
  const { bucket, provider, ...repo } = opts;
  return {
    chunkFileObjects: createChunkFileObjectRepository({
      ...repo,
      bucket,
      ...(provider ? { provider } : {}),
    }),
    recordings: createRecordingChunkCountRepository(repo),
    chunkLookup: createChunkFileObjectLookup(repo),
  };
}

/**
 * Chunk audio resolver (#92) over the persisted chunk rows: chunkFileObjectId -> audio, scoped to organizationId.
 * The lookup runs inside runWithOrganizationContext, so a row of another organization is never visible.
 */
export function createPersistedChunkAudioResolver(
  storage: ChunkAudioResolverDeps['storage'],
  persistence: Pick<MediaPersistence, 'chunkLookup'>,
  opts: { maxBytes?: number } = {},
) {
  return createChunkAudioResolver({
    storage,
    lookup: persistence.chunkLookup,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
}

/**
 * Fail-fast startup check for the media worker's database. Prisma connects lazily, so without this a missing
 * DATABASE_URL would only surface at the first job (after normalize and chunk upload). Checks presence and scheme only;
 * it never echoes the value. Wrong credentials or an unreachable database are still only detected at the first job.
 */
export function assertMediaWorkerDatabaseEnv(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for the media worker (use the meetops_app NOBYPASSRLS runtime role)',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
}
