import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext, type TransactionCapableClient } from './tenant.js';

/** Max length of TranscriptChunk.error (VARCHAR(500)). Store provider error codes, never response bodies. */
export const TRANSCRIPT_CHUNK_ERROR_MAX = 500;

export type TranscriptChunkStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface TranscriptChunkRecord {
  id: string;
  organizationId: string;
  transcriptId: string;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  status: TranscriptChunkStatus;
  provider: string;
  text: string | null;
  segments: unknown;
  attemptCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertChunkInput {
  transcriptId: string;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  provider: string;
  status?: TranscriptChunkStatus;
  text?: string | null;
  segments?: unknown;
}

export interface MarkChunkInput {
  transcriptId: string;
  chunkIndex: number;
  status: TranscriptChunkStatus;
  text?: string | null;
  segments?: unknown;
  /** Provider error code. Truncated to TRANSCRIPT_CHUNK_ERROR_MAX characters. */
  error?: string | null;
}

export interface CompleteMergeInput {
  /** true marks the merge failed instead of merged. */
  failed?: boolean;
  fullText?: string;
}

export interface RepositoryOptions {
  /** Defaults to the shared singleton from getPrismaClient(). */
  client?: TransactionCapableClient | PrismaClient;
  timeoutMs?: number;
}

type Row = {
  id: string;
  org_id: string;
  transcript_id: string;
  chunk_index: number;
  start_ms: number;
  end_ms: number;
  status: TranscriptChunkStatus;
  provider: string;
  text: string | null;
  segments: unknown;
  attempt_count: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

const toRecord = (r: Row): TranscriptChunkRecord => ({
  id: r.id,
  organizationId: r.org_id,
  transcriptId: r.transcript_id,
  chunkIndex: r.chunk_index,
  startMs: r.start_ms,
  endMs: r.end_ms,
  status: r.status,
  provider: r.provider,
  text: r.text,
  segments: r.segments,
  attemptCount: r.attempt_count,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Truncate a provider error code to the column limit. */
export function truncateChunkError(error: string | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  return error.length > TRANSCRIPT_CHUNK_ERROR_MAX
    ? error.slice(0, TRANSCRIPT_CHUNK_ERROR_MAX)
    : error;
}

const json = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/**
 * Chunked-transcription persistence. Every method runs in its own withOrganizationContext transaction,
 * so forced RLS scopes it to `organizationId`. Uses the shared client unless `options.client` is given.
 */
export function createTranscriptRepository(options: RepositoryOptions = {}) {
  const run = <T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  return {
    /**
     * Insert or update chunk (transcriptId, chunkIndex). A chunk that is already `done` is never changed:
     * `applied` is false and the stored row is returned.
     */
    upsertChunk(
      organizationId: string,
      input: UpsertChunkInput,
    ): Promise<{ applied: boolean; chunk: TranscriptChunkRecord }> {
      return run(organizationId, async (tx) => {
        const status = input.status ?? 'pending';
        const rows = await tx.$queryRaw<Row[]>`
          INSERT INTO "transcript_chunks"
            ("id", "org_id", "transcript_id", "chunk_index", "start_ms", "end_ms", "status", "provider",
             "text", "segments", "updated_at")
          VALUES (gen_random_uuid(), ${organizationId}::uuid, ${input.transcriptId}::uuid, ${input.chunkIndex},
                  ${input.startMs}, ${input.endMs}, ${status}::"TranscriptChunkStatus", ${input.provider},
                  ${input.text ?? null}, ${json(input.segments)}::jsonb, now())
          ON CONFLICT ("transcript_id", "chunk_index") DO UPDATE SET
            "start_ms" = EXCLUDED."start_ms",
            "end_ms" = EXCLUDED."end_ms",
            "status" = EXCLUDED."status",
            "provider" = EXCLUDED."provider",
            "text" = COALESCE(EXCLUDED."text", "transcript_chunks"."text"),
            "segments" = COALESCE(EXCLUDED."segments", "transcript_chunks"."segments"),
            "updated_at" = now()
          WHERE "transcript_chunks"."status" <> 'done'
          RETURNING *`;
        if (rows[0]) return { applied: true, chunk: toRecord(rows[0]) };
        const existing = await tx.$queryRaw<Row[]>`
          SELECT * FROM "transcript_chunks"
          WHERE "transcript_id" = ${input.transcriptId}::uuid AND "chunk_index" = ${input.chunkIndex}`;
        return { applied: false, chunk: toRecord(existing[0]!) };
      });
    },

    /**
     * Record an attempt outcome: sets status (and text/segments/error when given) and increments attemptCount.
     * A `done` chunk is never changed (returns null). The error is truncated to 500 characters.
     */
    markChunk(
      organizationId: string,
      input: MarkChunkInput,
    ): Promise<TranscriptChunkRecord | null> {
      return run(organizationId, async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          UPDATE "transcript_chunks" SET
            "status" = ${input.status}::"TranscriptChunkStatus",
            "text" = COALESCE(${input.text ?? null}, "text"),
            "segments" = COALESCE(${json(input.segments)}::jsonb, "segments"),
            "error" = ${truncateChunkError(input.error)},
            "attempt_count" = "attempt_count" + 1,
            "updated_at" = now()
          WHERE "transcript_id" = ${input.transcriptId}::uuid AND "chunk_index" = ${input.chunkIndex}
            AND "status" <> 'done'
          RETURNING *`;
        return rows[0] ? toRecord(rows[0]) : null;
      });
    },

    /** All chunks of a transcript, ordered by chunkIndex. */
    listChunks(organizationId: string, transcriptId: string): Promise<TranscriptChunkRecord[]> {
      return run(organizationId, async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          SELECT * FROM "transcript_chunks" WHERE "transcript_id" = ${transcriptId}::uuid
          ORDER BY "chunk_index" ASC`;
        return rows.map(toRecord);
      });
    },

    /** Move the transcript's merge from pending to merging. Exactly one concurrent caller gets true. */
    tryBeginMerge(organizationId: string, transcriptId: string): Promise<boolean> {
      return run(organizationId, async (tx) => {
        const n = await tx.$executeRaw`
          UPDATE "transcripts" SET "merge_status" = 'merging', "updated_at" = now()
          WHERE "id" = ${transcriptId}::uuid AND "merge_status" = 'pending'`;
        return n === 1;
      });
    },

    /** Finish a merge started by tryBeginMerge (merging -> merged | failed). Returns false if not merging. */
    completeMerge(
      organizationId: string,
      transcriptId: string,
      input: CompleteMergeInput = {},
    ): Promise<boolean> {
      return run(organizationId, async (tx) => {
        const status = input.failed ? 'failed' : 'merged';
        const n = await tx.$executeRaw`
          UPDATE "transcripts" SET
            "merge_status" = ${status}::"TranscriptMergeStatus",
            "merged_at" = CASE WHEN ${status} = 'merged' THEN now() ELSE "merged_at" END,
            "full_text" = COALESCE(${input.fullText ?? null}, "full_text"),
            "updated_at" = now()
          WHERE "id" = ${transcriptId}::uuid AND "merge_status" = 'merging'`;
        return n === 1;
      });
    },
  };
}

export type TranscriptRepository = ReturnType<typeof createTranscriptRepository>;
