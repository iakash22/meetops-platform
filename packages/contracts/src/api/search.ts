import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

const strict = { additionalProperties: false } as const;

/** Phase 7: org-scoped full-text search (Postgres FTS, forced RLS). */
export const SEARCH_PATHS = { search: '/orgs/:organizationId/search' } as const;

export const SEARCH_RESULT_KINDS = ['meeting', 'transcript', 'summary', 'task'] as const;
export const SearchResultKind = Type.Union(SEARCH_RESULT_KINDS.map((k) => Type.Literal(k)));
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/** Highlight markers in `snippet`: text between them matched the query. Render as text, never as HTML. */
export const SEARCH_HIGHLIGHT_START = '\u0002';
export const SEARCH_HIGHLIGHT_STOP = '\u0003';

export const SearchQuery = Type.Object(
  {
    /** Web-search syntax: words, "quoted phrases", OR, -exclude. */
    q: Type.String({
      minLength: 2,
      maxLength: 200,
      // No NUL / C0 control characters (Postgres text cannot hold NUL; markers are reserved for highlights).
      pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]*$',
    }),
    /** Comma-separated subset of SEARCH_RESULT_KINDS; default all. */
    kinds: Type.Optional(
      Type.String({
        pattern: '^(meeting|transcript|summary|task)(,(meeting|transcript|summary|task))*$',
        maxLength: 64,
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  strict,
);
export type SearchQuery = Static<typeof SearchQuery>;

export const SearchResult = Type.Object(
  {
    kind: SearchResultKind,
    /** Id of the matched row (meeting, transcript segment, report or task). */
    id: Id,
    /** Meeting the hit belongs to (absent for tasks with no meeting). */
    meetingId: Type.Optional(Id),
    title: Type.String({ maxLength: 500 }),
    snippet: Type.String({ maxLength: 2000 }),
    rank: Type.Number({ minimum: 0 }),
    /** Transcript hits: segment start offset in ms. */
    startMs: Type.Optional(Type.Integer({ minimum: 0 })),
    occurredAt: IsoDateTime,
  },
  strict,
);
export type SearchResult = Static<typeof SearchResult>;

export const SearchResponse = Type.Object(
  { items: Type.Array(SearchResult, { maxItems: 50 }) },
  strict,
);
export type SearchResponse = Static<typeof SearchResponse>;
