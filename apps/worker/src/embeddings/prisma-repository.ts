import { withOrganizationContext, type DatabaseClient } from '@meetops/database';
import { EMBEDDING_DIMS } from '@meetops/ai-core';
import type { EmbeddingRepository, EmbeddingRow, EmbeddingSource } from './pipeline.js';

const toVector = (v: number[]) => {
  if (v.length !== EMBEDDING_DIMS || !v.every((x) => Number.isFinite(x)))
    throw new RangeError('embedding size mismatch');
  return `[${v.join(',')}]`;
};

/**
 * meeting_embeddings writer (migration 20261031050000). Every call runs in withOrganizationContext (forced RLS) and
 * filters org_id explicitly; sources are only the meeting's current transcript revision and live summaries.
 */
export function createPrismaEmbeddingRepository(
  opts: { client?: DatabaseClient } = {},
): EmbeddingRepository {
  const run = <T>(org: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) =>
    withOrganizationContext(org, fn, opts.client ? { client: opts.client } : {});
  return {
    listSources: (org, meetingId, limit) =>
      run(
        org,
        (tx) =>
          tx.$queryRaw<EmbeddingSource[]>`
          (SELECT 'transcript_segment' AS kind, sg.id, sg.text
             FROM transcript_segments sg
             JOIN transcripts tr ON tr.org_id = sg.org_id AND tr.id = sg.transcript_id
                                AND tr.deleted_at IS NULL AND sg.revision = tr.revision
            WHERE sg.org_id = ${org}::uuid AND tr.meeting_id = ${meetingId}::uuid AND btrim(sg.text) <> ''
            ORDER BY sg.start_ms, sg.sequence
            LIMIT ${limit})
          UNION ALL
          (SELECT 'summary', r.id, coalesce(r.title, '') || E'\n' || coalesce(r.summary, '')
             FROM reports r
            WHERE r.org_id = ${org}::uuid AND r.meeting_id = ${meetingId}::uuid AND r.deleted_at IS NULL
              AND btrim(coalesce(r.summary, '')) <> ''
            ORDER BY r.created_at
            LIMIT ${limit})`,
      ).then((rows) => rows.slice(0, limit)),
    storedHashes: async (org, meetingId) => {
      const rows = await run(
        org,
        (tx) =>
          tx.$queryRaw<{ id: string; sha: string }[]>`
          SELECT coalesce(segment_id, report_id) AS id, content_sha256 AS sha
            FROM meeting_embeddings
           WHERE org_id = ${org}::uuid AND meeting_id = ${meetingId}::uuid`,
      );
      const m = new Map<string, Set<string>>();
      for (const r of rows) (m.get(r.id) ?? m.set(r.id, new Set()).get(r.id)!).add(r.sha);
      return m;
    },
    upsert: (org, meetingId, model, rows: EmbeddingRow[]) =>
      run(org, async (tx) => {
        let n = 0;
        for (const r of rows) {
          const vec = toVector(r.vector);
          n +=
            r.kind === 'transcript_segment'
              ? await tx.$executeRaw`
                INSERT INTO meeting_embeddings
                  (id, org_id, meeting_id, source_kind, segment_id, model, content_sha256, embedding, updated_at)
                VALUES (gen_random_uuid(), ${org}::uuid, ${meetingId}::uuid, 'transcript_segment', ${r.id}::uuid,
                        ${model}, ${r.sha256}, ${vec}::vector, now())
                ON CONFLICT (org_id, segment_id, model) DO UPDATE
                  SET content_sha256 = EXCLUDED.content_sha256, embedding = EXCLUDED.embedding, updated_at = now()`
              : await tx.$executeRaw`
                INSERT INTO meeting_embeddings
                  (id, org_id, meeting_id, source_kind, report_id, model, content_sha256, embedding, updated_at)
                VALUES (gen_random_uuid(), ${org}::uuid, ${meetingId}::uuid, 'summary', ${r.id}::uuid,
                        ${model}, ${r.sha256}, ${vec}::vector, now())
                ON CONFLICT (org_id, report_id, model) DO UPDATE
                  SET content_sha256 = EXCLUDED.content_sha256, embedding = EXCLUDED.embedding, updated_at = now()`;
        }
        return n;
      }),
  };
}
