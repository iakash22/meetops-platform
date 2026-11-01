import {
  SEARCH_HIGHLIGHT_START,
  SEARCH_HIGHLIGHT_STOP,
  SEARCH_PATHS,
  SEARCH_RESULT_KINDS,
} from '@meetops/contracts/types';
import type { Id, SearchResponse, SearchResultKind } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { fillPath } from '@/features/uploads/types';

export { SEARCH_PATHS, SEARCH_RESULT_KINDS };
export type { SearchResponse, SearchResultKind };

export interface SearchApi {
  search(
    organizationId: Id,
    q: string,
    kinds?: readonly SearchResultKind[],
  ): Promise<SearchResponse>;
}

export function createHttpSearchApi(request: ApiClient['request']): SearchApi {
  return {
    search: (o, q, kinds) => {
      const p = new URLSearchParams({ q });
      if (kinds && kinds.length && kinds.length < SEARCH_RESULT_KINDS.length)
        p.set('kinds', kinds.join(','));
      return request(
        'GET',
        `${fillPath(SEARCH_PATHS.search, { organizationId: o })}?${p.toString()}`,
      );
    },
  };
}

/** Splits a server snippet into plain/matched parts. Rendered as text nodes only (never as HTML). */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let match = false;
  let buf = '';
  for (const ch of snippet) {
    if (ch === SEARCH_HIGHLIGHT_START || ch === SEARCH_HIGHLIGHT_STOP) {
      if (buf) out.push({ text: buf, match });
      buf = '';
      match = ch === SEARCH_HIGHLIGHT_START;
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, match });
  return out;
}

export type SearchPageSearch = { q?: string | undefined; kind?: SearchResultKind | undefined };
export function parseSearchPageSearch(s: Record<string, unknown>): SearchPageSearch {
  const q = typeof s.q === 'string' ? s.q.slice(0, 200) : undefined;
  const kind =
    typeof s.kind === 'string' && (SEARCH_RESULT_KINDS as readonly string[]).includes(s.kind)
      ? (s.kind as SearchResultKind)
      : undefined;
  return { q: q || undefined, kind };
}

let override: SearchApi | null = null;
export function setSearchApiOverride(api: SearchApi | null): void {
  override = api;
}
export function getSearchApi(request: ApiClient['request']): SearchApi {
  return override ?? createHttpSearchApi(request);
}
