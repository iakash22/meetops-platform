import {
  SEARCH_HIGHLIGHT_START as S,
  SEARCH_HIGHLIGHT_STOP as E,
  type SearchResult,
} from '@meetops/contracts';
import type { SearchInput, SearchRepository } from './ports.js';

export type SearchDoc = Omit<SearchResult, 'snippet' | 'rank'> & {
  organizationId: string;
  body: string;
};

/** Dev/test stand-in: case-insensitive all-terms match over seeded docs. Postgres FTS is the real implementation. */
export class InMemorySearch implements SearchRepository {
  readonly docs: SearchDoc[] = [];
  async search(organizationId: string, input: SearchInput): Promise<SearchResult[]> {
    const terms = input.q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean);
    if (!terms.length) return [];
    return this.docs
      .filter((d) => d.organizationId === organizationId && input.kinds.includes(d.kind))
      .map((d) => {
        const text = `${d.title} ${d.body}`.toLowerCase();
        const hits = terms.filter((t) => text.includes(t)).length;
        return { d, hits };
      })
      .filter((x) => x.hits === terms.length)
      .slice(0, input.limit)
      .map(({ d }) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { organizationId: _o, body, ...rest } = d;
        // eslint-disable-next-line no-control-regex
        let snippet = body.replace(/[\u0002\u0003]/g, '').slice(0, 200);
        for (const t of terms) snippet = snippet.replace(new RegExp(`(${t})`, 'ig'), `${S}$1${E}`);
        return { ...rest, snippet, rank: 1 };
      });
  }
}
