import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

const strict = { additionalProperties: false } as const;

export {
  SEARCH_HIGHLIGHT_START,
  SEARCH_HIGHLIGHT_STOP,
  SEARCH_PATHS,
  SEARCH_RESULT_KINDS,
} from '../constants.js';
import { SEARCH_RESULT_KINDS } from '../constants.js';

export const SearchResultKind = Type.Union(SEARCH_RESULT_KINDS.map((k) => Type.Literal(k)));
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

export const SearchQuery = Type.Object(
  {
    /** Web-search syntax: words, "quoted phrases", OR, -exclude. */
    q: Type.String({ minLength: 2, maxLength: 200 }),
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
