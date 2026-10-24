import type { Readable } from 'node:stream';
import type { PresignedUrl } from '@meetops/contracts/legacy';
import { StorageAccessError, StorageNotFoundError, StorageValidationError } from './errors.js';
import { assertKeyOwnedBy, buildObjectKey, parseMeetingKey, type MeetingObjectRef } from './keys.js';
import type { StorageService } from './types.js';

/**
 * The FileObject columns the resolver needs (packages/database `file_objects`: id, org_id, meeting_id, kind,
 * storage_key, mime_type, size_bytes, chunk_index). Chunk ids are deterministic uuidv5 values that cannot be
 * reversed into a key, so the key always comes from this row; it is then re-derived and checked here.
 */
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

/** Looks up one FileObject by id. Implementations should run inside withOrgContext(organizationId) (RLS). */
export interface ChunkFileObjectLookup {
  findFileObject(q: { organizationId: string; fileObjectId: string }): Promise<ChunkFileObjectRecord | null>;
}

export type ResolvedChunkStream = { kind: 'stream'; body: Readable; mimeType: string; sizeBytes?: number };
export type ResolvedChunkUrl = { kind: 'url'; url: PresignedUrl; mimeType: string };

/** Short-lived by design: chunk download URLs default to 120 s and may not exceed 300 s. */
export const AUDIO_URL_DEFAULT_TTL_SECONDS = 120;
export const AUDIO_URL_MAX_TTL_SECONDS = 300;
/** A 600 s 16 kHz mono s16le chunk is ~19.2 MB; 64 MiB leaves headroom for longer segments. */
export const DEFAULT_MAX_CHUNK_AUDIO_BYTES = 64 * 1024 * 1024;

const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHUNK_REST = /^processed\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/chunks\/(\d{5})\.wav$/;

export type ChunkAudioResolverDeps = {
  storage: Pick<StorageService, 'getObject' | 'getPresignedDownloadUrl'>;
  lookup: ChunkFileObjectLookup;
  maxBytes?: number;
};

/**
 * Resolve a transcription chunk (chunkFileObjectId) to audio, scoped to organizationId. Denies (StorageAccessError,
 * no key echoed) when the row belongs to another organization, is not a chunk, or its key is not exactly the
 * server-derived organizations/{organizationId}/meetings/{meetingId}/processed/{recordingId}/chunks/{nnnnn}.wav.
 */
export function createChunkAudioResolver(deps: ChunkAudioResolverDeps) {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_CHUNK_AUDIO_BYTES;

  async function resolveRef(q: { organizationId: string; fileObjectId: string }): Promise<{ ref: MeetingObjectRef; row: ChunkFileObjectRecord }> {
    if (typeof q?.organizationId !== 'string' || !UUIDISH.test(q.organizationId)) throw new StorageValidationError('Invalid organizationId');
    if (typeof q.fileObjectId !== 'string' || !UUIDISH.test(q.fileObjectId)) throw new StorageValidationError('Invalid fileObjectId');
    const row = await deps.lookup.findFileObject({ organizationId: q.organizationId, fileObjectId: q.fileObjectId });
    if (!row) throw new StorageNotFoundError();
    if (row.id !== q.fileObjectId || row.organizationId !== q.organizationId) throw new StorageAccessError();
    if (row.kind !== 'chunk' || !row.meetingId) throw new StorageAccessError();
    assertKeyOwnedBy(row.key, q.organizationId, row.meetingId);
    const parsed = parseMeetingKey(row.key);
    const m = parsed ? CHUNK_REST.exec(parsed.rest) : null;
    if (!parsed || !m) throw new StorageAccessError();
    const index = Number(m[2]);
    if (row.chunkIndex !== undefined && row.chunkIndex !== null && row.chunkIndex !== index) throw new StorageAccessError();
    const ref: MeetingObjectRef = { organizationId: q.organizationId, meetingId: row.meetingId, kind: 'chunk', objectId: m[1]!, index };
    if (buildObjectKey(ref) !== row.key) throw new StorageAccessError();
    return { ref, row };
  }

  return {
    /** Stream the chunk. Rejects rows whose recorded size exceeds maxBytes before touching storage. */
    async stream(q: { organizationId: string; fileObjectId: string }): Promise<ResolvedChunkStream> {
      const { ref, row } = await resolveRef(q);
      const declared = row.sizeBytes === undefined || row.sizeBytes === null ? undefined : Number(row.sizeBytes);
      if (declared !== undefined && declared > maxBytes) throw new StorageValidationError('Chunk exceeds size limit');
      const { body, info } = await deps.storage.getObject(ref);
      if (info.sizeBytes > maxBytes) {
        body.destroy();
        throw new StorageValidationError('Chunk exceeds size limit');
      }
      return { kind: 'stream', body, mimeType: row.mimeType, ...(info.sizeBytes ? { sizeBytes: info.sizeBytes } : {}) };
    },

    /** Short-lived presigned GET (default 120 s, max 300 s). */
    async url(q: { organizationId: string; fileObjectId: string }, opts: { ttlSeconds?: number } = {}): Promise<ResolvedChunkUrl> {
      const ttl = opts.ttlSeconds ?? AUDIO_URL_DEFAULT_TTL_SECONDS;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > AUDIO_URL_MAX_TTL_SECONDS) throw new StorageValidationError('ttlSeconds out of range');
      const { ref, row } = await resolveRef(q);
      return { kind: 'url', url: await deps.storage.getPresignedDownloadUrl(ref, { ttlSeconds: ttl }), mimeType: row.mimeType };
    },

    /** Read the chunk into memory (capped by maxBytes while streaming). Matches ai-core AudioResolver's {bytes, mimeType}. */
    async bytes(q: { organizationId: string; fileObjectId: string }): Promise<{ bytes: Uint8Array; mimeType: string }> {
      const s = await this.stream(q);
      const parts: Buffer[] = [];
      let n = 0;
      for await (const c of s.body) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        n += b.byteLength;
        if (n > maxBytes) {
          s.body.destroy();
          throw new StorageValidationError('Chunk exceeds size limit');
        }
        parts.push(b);
      }
      return { bytes: new Uint8Array(Buffer.concat(parts)), mimeType: s.mimeType };
    }
  };
}

export type ChunkAudioResolver = ReturnType<typeof createChunkAudioResolver>;
