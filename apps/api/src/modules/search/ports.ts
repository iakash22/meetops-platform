import type { SearchResult, SearchResultKind } from '@meetops/contracts';

export type SearchInput = { q: string; kinds: readonly SearchResultKind[]; limit: number };

/** Org-scoped full-text search. Implementations must only ever return rows of `organizationId`. */
export interface SearchRepository {
  search(organizationId: string, input: SearchInput): Promise<SearchResult[]>;
}
