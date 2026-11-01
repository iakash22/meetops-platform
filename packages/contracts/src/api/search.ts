import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

const strict = { additionalProperties: false } as const;

export {
  SEARCH_HIGHLIGHT_START,
  SEARCH_HIGHLIGHT_STOP,
  SEARCH_PATHS,
  SEARCH_RESULT_KINDS,
  SEMANTIC_SEARCH_KINDS,
} from '../constants.js';
import { SEARCH_RESULT_KINDS, SEMANTIC_SEARCH_KINDS } from '../constants.js';

export const SearchResultKind = Type.Union(SEARCH_RESULT_KINDS.map((k) => Type.Literal(k)));
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

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

export const SemanticSearchKind = Type.Union(SEMANTIC_SEARCH_KINDS.map((k) => Type.Literal(k)));
export type SemanticSearchKind = (typeof SEMANTIC_SEARCH_KINDS)[number];

/** GET /orgs/:organizationId/search/semantic. Natural-language query; results are ranked by vector similarity. */
export const SemanticSearchQuery = Type.Object(
  {
    q: Type.String({
      minLength: 2,
      maxLength: 500,
      pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]*$',
    }),
    /** Comma-separated subset of SEMANTIC_SEARCH_KINDS; default both. */
    kinds: Type.Optional(
      Type.String({ pattern: '^(transcript|summary)(,(transcript|summary))*$', maxLength: 32 }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  strict,
);
export type SemanticSearchQuery = Static<typeof SemanticSearchQuery>;

export const SemanticSearchResult = Type.Object(
  {
    kind: SemanticSearchKind,
    /** Transcript segment id or report id. */
    id: Id,
    meetingId: Id,
    title: Type.String({ maxLength: 500 }),
    /** Plain text excerpt of the matched content (no highlight markers). */
    snippet: Type.String({ maxLength: 2000 }),
    /** Cosine similarity, -1..1 (higher is closer). */
    score: Type.Number({ minimum: -1, maximum: 1 }),
    startMs: Type.Optional(Type.Integer({ minimum: 0 })),
    occurredAt: IsoDateTime,
  },
  strict,
);
export type SemanticSearchResult = Static<typeof SemanticSearchResult>;

export const SemanticSearchResponse = Type.Object(
  { items: Type.Array(SemanticSearchResult, { maxItems: 20 }) },
  strict,
);
export type SemanticSearchResponse = Static<typeof SemanticSearchResponse>;
