import type { SearchResult, SearchResultKind } from '@meetops/contracts';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import type { SearchInput, SearchRepository } from './ports.js';

type Row = {
  kind: SearchResultKind;
  id: string;
  meeting_id: string | null;
  title: string | null;
  snippet: string | null;
  rank: number;
  start_ms: number | null;
  occurred_at: Date;
};

/**
 * Postgres full-text search over meetings, the current transcript revision's segments, summaries (reports) and
 * tasks. Runs as the app role inside withOrganizationContext, so forced RLS restricts every table to the caller's
 * organization; each branch also filters org_id explicitly (defense in depth). The to_tsvector expressions match the
 * GIN indexes in migration 20261031010000_meeting_search_fts. The query text is a bound parameter parsed by
 * websearch_to_tsquery (never concatenated into SQL). Snippets use \u0002/\u0003 as highlight markers.
 */
export class PrismaSearch implements SearchRepository {
  constructor(private readonly db: DatabaseClient) {}

  async search(organizationId: string, input: SearchInput): Promise<SearchResult[]> {
    const k = (x: SearchResultKind) => input.kinds.includes(x);
    const [m, t, s, tk] = [k('meeting'), k('transcript'), k('summary'), k('task')];
    const org = organizationId;
    const per = input.limit;
    const rows = await withOrganizationContext(
      organizationId,
      (tx) => tx.$queryRaw<Row[]>`
        WITH q AS (SELECT websearch_to_tsquery('english'::regconfig, ${input.q}) AS query),
        hits AS (
          (SELECT 'meeting'::text AS kind, mt.id, mt.id AS meeting_id, mt.title,
                  coalesce(mt.title, '') || ' ' || coalesce(mt.description, '') AS body,
                  ts_rank(to_tsvector('english'::regconfig, coalesce(mt.title, '') || ' ' || coalesce(mt.description, '')), q.query) AS rank,
                  NULL::int AS start_ms, coalesce(mt.started_at, mt.scheduled_at, mt.created_at) AS occurred_at
             FROM meetings mt, q
            WHERE ${m} AND mt.org_id = ${org}::uuid AND mt.deleted_at IS NULL
              AND to_tsvector('english'::regconfig, coalesce(mt.title, '') || ' ' || coalesce(mt.description, '')) @@ q.query
            ORDER BY rank DESC LIMIT ${per})
          UNION ALL
          (SELECT 'transcript', sg.id, tr.meeting_id, mt.title, sg.text,
                  ts_rank(to_tsvector('english'::regconfig, sg.text), q.query),
                  sg.start_ms, coalesce(mt.started_at, mt.created_at)
             FROM transcript_segments sg
             JOIN transcripts tr ON tr.id = sg.transcript_id AND tr.org_id = sg.org_id
                                AND tr.deleted_at IS NULL AND sg.revision = tr.revision
             JOIN meetings mt ON mt.id = tr.meeting_id AND mt.org_id = tr.org_id AND mt.deleted_at IS NULL,
                  q
            WHERE ${t} AND sg.org_id = ${org}::uuid
              AND to_tsvector('english'::regconfig, sg.text) @@ q.query
            ORDER BY 6 DESC LIMIT ${per})
          UNION ALL
          (SELECT 'summary', r.id, r.meeting_id, coalesce(r.title, mt.title),
                  coalesce(r.title, '') || ' ' || coalesce(r.summary, ''),
                  ts_rank(to_tsvector('english'::regconfig, coalesce(r.title, '') || ' ' || coalesce(r.summary, '')), q.query),
                  NULL::int, r.created_at
             FROM reports r
             JOIN meetings mt ON mt.id = r.meeting_id AND mt.org_id = r.org_id AND mt.deleted_at IS NULL,
                  q
            WHERE ${s} AND r.org_id = ${org}::uuid AND r.deleted_at IS NULL
              AND to_tsvector('english'::regconfig, coalesce(r.title, '') || ' ' || coalesce(r.summary, '')) @@ q.query
            ORDER BY 6 DESC LIMIT ${per})
          UNION ALL
          (SELECT 'task', tk.id, tk.meeting_id, tk.title,
                  coalesce(tk.title, '') || ' ' || coalesce(tk.description, ''),
                  ts_rank(to_tsvector('english'::regconfig, coalesce(tk.title, '') || ' ' || coalesce(tk.description, '')), q.query),
                  NULL::int, tk.created_at
             FROM tasks tk, q
            WHERE ${tk} AND tk.org_id = ${org}::uuid AND tk.deleted_at IS NULL
              AND to_tsvector('english'::regconfig, coalesce(tk.title, '') || ' ' || coalesce(tk.description, '')) @@ q.query
            ORDER BY 6 DESC LIMIT ${per})
        )
        SELECT h.kind, h.id, h.meeting_id, h.title, h.rank::float8 AS rank, h.start_ms, h.occurred_at,
               ts_headline('english'::regconfig, h.body, q.query,
                 'StartSel=' || chr(2) || ', StopSel=' || chr(3) || ', MaxWords=30, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "') AS snippet
          FROM hits h, q
         ORDER BY h.rank DESC, h.occurred_at DESC, h.id
         LIMIT ${per}
      `,
      { client: this.db },
    );
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      ...(r.meeting_id ? { meetingId: r.meeting_id } : {}),
      title: (r.title ?? '').slice(0, 500),
      snippet: (r.snippet ?? '').slice(0, 2000),
      rank: Number.isFinite(r.rank) && r.rank > 0 ? r.rank : 0,
      ...(r.start_ms !== null && r.start_ms >= 0 ? { startMs: r.start_ms } : {}),
      occurredAt: r.occurred_at.toISOString(),
    }));
  }
}
