import type { ChunkTranscript, TranscriptRevision } from '@meetops/ai-core';
import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@meetops/database';
import type {
  OrgScopedRecordingTranscriptRepository,
  RecordingTranscriptRepository,
  TranscriptRevisionWrite,
} from './repository.js';

/**
 * Postgres-backed `TranscriptRepository` for the transcription consumer (Phase 3).
 *
 * Layout (migration 20261026200000_transcript_recording_revision):
 * - Revision 0 of `transcripts` is a per-recording anchor. It owns the raw per-chunk STT results in
 *   `transcript_chunks` (`segments` holds the ai-core `ChunkTranscript`; `status = done`).
 *   Each chunk's AssemblyAI (or other STT) job id is already stored on the
 *   `transcript_chunks.segments` JSON (`ChunkTranscript.providerJobId`). Deletes
 *   read every id from there. The same id is still copied onto the revision-0
 *   `transcripts.provider_job_id` so PR 513-era readers keep working; a later
 *   chunk may overwrite the anchor, but that is no longer the delete source.
 * - Revisions >= 1 are merged transcripts: `full_text`, `merge_state` (ai-core merge state) and their
 *   `transcript_segments` rows (same `revision`).
 *
 * Every call runs in one `withOrganizationContext` transaction (forced RLS) and also filters on
 * `organizationId`, so a row of another organization is never read or written.
 */
export type PrismaTranscriptRepositoryOptions = { client?: DatabaseClient; timeoutMs?: number };

const ANCHOR_REVISION = 0;
const KNOWN_PROVIDERS = new Set(['assemblyai', 'faster-whisper', 'deepgram', 'unknown']);
const providerOf = (p: string) => (KNOWN_PROVIDERS.has(p) ? p : 'unknown');

const isChunkTranscript = (v: unknown): v is ChunkTranscript => {
  if (typeof v !== 'object' || v === null) return false;
  const row = v as ChunkTranscript;
  if (typeof row.chunkIndex !== 'number' || !Array.isArray(row.segments)) return false;
  // When present, providerJobId must be a string so deletes never read a coerced value.
  if (row.providerJobId !== undefined && typeof row.providerJobId !== 'string') return false;
  return true;
};
const isRevision = (v: unknown): v is TranscriptRevision =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as TranscriptRevision).revision === 'number' &&
  typeof (v as TranscriptRevision).contentHash === 'string';

export function createOrgScopedTranscriptRepository(
  tx: DatabaseTransaction,
  organizationId: string,
): OrgScopedRecordingTranscriptRepository {
  const findRecordingRow = (recordingId: string) =>
    tx.recording.findFirst({
      where: { id: recordingId, organizationId, deletedAt: null },
      select: { id: true, meetingId: true, chunkCount: true },
    });

  const findAnchor = (meetingId: string, recordingId: string) =>
    tx.transcript.findFirst({
      where: { organizationId, meetingId, recordingId, revision: ANCHOR_REVISION },
      select: { id: true },
    });

  async function ensureAnchor(
    meetingId: string,
    recordingId: string,
    provider: string,
  ): Promise<string> {
    const found = await findAnchor(meetingId, recordingId);
    if (found) return found.id;
    // (recording_id, revision) is unique. ON CONFLICT keeps the transaction usable when a concurrent worker wins.
    await tx.$executeRaw`
      INSERT INTO "transcripts" ("id", "org_id", "meeting_id", "recording_id", "provider", "revision", "status", "updated_at")
      VALUES (gen_random_uuid(), ${organizationId}::uuid, ${meetingId}::uuid, ${recordingId}::uuid, ${providerOf(provider)},
        ${ANCHOR_REVISION}, 'processing'::"TranscriptStatus", now())
      ON CONFLICT ("recording_id", "revision") DO NOTHING`;
    const created = await findAnchor(meetingId, recordingId);
    if (!created) throw new Error('transcript anchor not visible after insert');
    return created.id;
  }

  const chunkRows = async (meetingId: string, recordingId: string, chunkIndex?: number) => {
    const anchor = await findAnchor(meetingId, recordingId);
    if (!anchor) return [];
    return tx.transcriptChunk.findMany({
      where: {
        organizationId,
        transcriptId: anchor.id,
        status: 'done',
        ...(chunkIndex === undefined ? {} : { chunkIndex }),
      },
      orderBy: { chunkIndex: 'asc' },
      select: { segments: true },
    });
  };
  const toChunks = (rows: Array<{ segments: unknown }>) =>
    rows.map((r) => r.segments).filter(isChunkTranscript);

  return {
    async markTranscriptFailed(meetingId, recordingId, provider) {
      const anchorId = await ensureAnchor(meetingId, recordingId, provider);
      await tx.transcript.updateMany({
        where: { organizationId, id: anchorId, revision: ANCHOR_REVISION },
        data: { status: 'failed' },
      });
    },
    async findMeeting(meetingId) {
      const m = await tx.meeting.findFirst({
        where: { id: meetingId, organizationId, deletedAt: null },
        select: { id: true, organizationId: true },
      });
      return m ?? undefined;
    },
    async findRecording(recordingId) {
      const r = await findRecordingRow(recordingId);
      return r
        ? {
            id: r.id,
            organizationId,
            meetingId: r.meetingId,
            chunkCount: r.chunkCount ?? undefined,
          }
        : undefined;
    },
    async putChunkResult(meetingId, recordingId, chunk) {
      const transcriptId = await ensureAnchor(meetingId, recordingId, chunk.provider);
      const startMs = Math.max(0, Math.round(chunk.startSec * 1000));
      const endMs = Math.max(startMs, Math.round((chunk.startSec + chunk.durationSec) * 1000));
      // First write wins: (transcript_id, chunk_index) is unique; ON CONFLICT DO NOTHING keeps the earlier result.
      const inserted = await tx.$executeRaw`
        INSERT INTO "transcript_chunks"
          ("id", "org_id", "transcript_id", "chunk_index", "start_ms", "end_ms", "status", "provider", "text", "segments", "attempt_count", "updated_at")
        VALUES (gen_random_uuid(), ${organizationId}::uuid, ${transcriptId}::uuid, ${chunk.chunkIndex}, ${startMs}, ${endMs},
          'done'::"TranscriptChunkStatus", ${chunk.provider}, ${chunk.segments.map((s) => s.text).join(' ')},
          ${JSON.stringify(chunk)}::jsonb, 1, now())
        ON CONFLICT ("transcript_id", "chunk_index") DO NOTHING`;
      // Also copy the id onto the revision-0 anchor for PR 513 compatibility. Not written on merged
      // revisions (unique (org, provider, provider_job_id) would conflict with the anchor).
      // Deletes do not rely on this overwriteable column; they read every id from segments JSON.
      if (inserted === 1 && chunk.providerJobId) {
        await tx.transcript.updateMany({
          where: { organizationId, id: transcriptId, revision: ANCHOR_REVISION },
          data: { providerJobId: chunk.providerJobId },
        });
      }
      return inserted === 1;
    },
    async getProviderJobId(meetingId, recordingId) {
      const row = await tx.transcript.findFirst({
        where: {
          organizationId,
          meetingId,
          recordingId,
          revision: ANCHOR_REVISION,
        },
        select: { providerJobId: true },
      });
      return row?.providerJobId ?? undefined;
    },
    async listProviderJobIds(meetingId, recordingId) {
      const ids: string[] = [];
      const seen = new Set<string>();
      const add = (id: string | null | undefined) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
      };
      // Source of truth: providerJobId already stored on each chunk's segments JSON.
      for (const chunk of toChunks(await chunkRows(meetingId, recordingId)))
        add(chunk.providerJobId);
      // Legacy rows whose segments predate providerJobId may only have the anchor column.
      const anchorRow = await tx.transcript.findFirst({
        where: { organizationId, meetingId, recordingId, revision: ANCHOR_REVISION },
        select: { providerJobId: true },
      });
      add(anchorRow?.providerJobId);
      return ids;
    },
    async getChunkResult(meetingId, recordingId, chunkIndex) {
      return toChunks(await chunkRows(meetingId, recordingId, chunkIndex))[0];
    },
    async listChunkResults(meetingId, recordingId) {
      return toChunks(await chunkRows(meetingId, recordingId));
    },
    async latestTranscript(meetingId, recordingId) {
      const row = await tx.transcript.findFirst({
        where: {
          organizationId,
          meetingId,
          recordingId,
          revision: { gt: ANCHOR_REVISION },
          deletedAt: null,
        },
        orderBy: { revision: 'desc' },
        select: { mergeState: true },
      });
      return isRevision(row?.mergeState) ? row.mergeState : undefined;
    },
    async writeTranscriptRevision(write: TranscriptRevisionWrite, expectedPrev: number) {
      if (write.organizationId !== organizationId)
        throw new Error('cross-organization transcript write');
      if (write.revision !== expectedPrev + 1) return false;
      const latest = await tx.transcript.findFirst({
        where: {
          organizationId,
          recordingId: write.recordingId,
          revision: { gt: ANCHOR_REVISION },
        },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      if ((latest?.revision ?? 0) !== expectedPrev) return false;
      const ready = write.status === 'ready';
      // Insert-if-absent: a concurrent writer that took this revision makes the compare-and-set lose (no rows).
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "transcripts"
          ("id", "org_id", "meeting_id", "recording_id", "provider", "revision", "status", "language", "full_text",
           "merge_status", "merged_at", "merge_state", "updated_at")
        VALUES (gen_random_uuid(), ${organizationId}::uuid, ${write.meetingId}::uuid, ${write.recordingId}::uuid,
          ${providerOf(write.provider)}, ${write.revision},
          ${ready ? 'ready' : 'processing'}::"TranscriptStatus", ${write.language}, ${write.fullText},
          ${ready ? 'merged' : 'pending'}::"TranscriptMergeStatus", ${ready ? new Date() : null},
          ${JSON.stringify(write.mergeState)}::jsonb, now())
        ON CONFLICT ("recording_id", "revision") DO NOTHING
        RETURNING "id"`;
      const t = rows[0];
      if (!t) return false;
      if (write.segments.length > 0)
        await tx.transcriptSegment.createMany({
          data: write.segments.map((s) => ({
            organizationId,
            transcriptId: t.id,
            revision: write.revision,
            ...s,
          })),
        });
      return true;
    },
  };
}

export function createPrismaTranscriptRepository(
  opts: PrismaTranscriptRepositoryOptions = {},
): RecordingTranscriptRepository {
  return {
    withOrgContext: (organizationId, fn) =>
      withOrganizationContext(
        organizationId,
        (tx) => fn(createOrgScopedTranscriptRepository(tx, organizationId)),
        {
          ...(opts.client ? { client: opts.client } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        },
      ),
  };
}
