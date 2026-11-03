import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search, Sparkles } from 'lucide-react';
import type { SearchResult, SemanticSearchResult } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { PageHeader } from '@/components/ui/typography';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import {
  SEARCH_RESULT_KINDS,
  getSearchApi,
  semanticKindFor,
  snippetParts,
  type SearchPageSearch,
  type SearchResultKind,
} from './api';

const KIND_LABEL: Record<SearchResultKind, string> = {
  meeting: 'Meeting',
  transcript: 'Transcript',
  summary: 'Summary',
  task: 'Task',
};

function Snippet({ text }: { text: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      {snippetParts(text).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded bg-primary/15 px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function ResultLink({ r }: { r: SearchResult }) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{KIND_LABEL[r.kind]}</Badge>
        <span className="truncate font-medium">{r.title || 'Untitled'}</span>
      </div>
      <Snippet text={r.snippet} />
    </>
  );
  const cls = 'block space-y-1 rounded-md p-3 hover:bg-muted focus-visible:bg-muted';
  if (r.kind === 'task')
    return (
      <Link to="/tasks" className={cls}>
        {body}
      </Link>
    );
  if (r.meetingId)
    return (
      <Link to="/meetings/$meetingId" params={{ meetingId: r.meetingId }} className={cls}>
        {body}
      </Link>
    );
  return <div className={cls}>{body}</div>;
}

function SemanticResultLink({ r }: { r: SemanticSearchResult }) {
  return (
    <Link
      to="/meetings/$meetingId"
      params={{ meetingId: r.meetingId }}
      className="block space-y-1 rounded-md p-3 hover:bg-muted focus-visible:bg-muted"
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{KIND_LABEL[r.kind]}</Badge>
        <span className="truncate font-medium">{r.title || 'Untitled'}</span>
      </div>
      {/* Plain text excerpt, rendered as a text node (never HTML). */}
      <p className="text-sm text-muted-foreground">{r.snippet}</p>
    </Link>
  );
}

/** 404 means the API build has semantic search switched off (SEMANTIC_SEARCH_ENABLED=false). */
const isSemanticOff = (err: unknown) => err instanceof ApiError && err.status === 404;

export function SearchPage({
  search,
  onSearchChange,
}: {
  search: SearchPageSearch;
  onSearchChange: (next: SearchPageSearch) => void;
}) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const searchApi = getSearchApi(api.request);
  const [draft, setDraft] = useState(search.q ?? '');
  useEffect(() => setDraft(search.q ?? ''), [search.q]);
  const [semanticOn, setSemanticOn] = useState(false);
  const q = (search.q ?? '').trim();
  const semKind = semanticKindFor(search.kind);
  const semanticActive = semanticOn && semKind !== null;
  const semantic = useQuery({
    queryKey: ['orgs', organizationId, 'search', 'semantic', q, semKind ?? 'all'],
    queryFn: () =>
      searchApi.semantic(organizationId, q, semKind && semKind !== 'all' ? [semKind] : undefined),
    enabled: !!organizationId && q.length >= 2 && semanticActive,
    retry: (count, err) => !isSemanticOff(err) && count < 1,
  });
  const semanticOff = semanticActive && semantic.isError && isSemanticOff(semantic.error);
  const useKeyword = !semanticActive || semanticOff;
  const result = useQuery({
    queryKey: ['orgs', organizationId, 'search', q, search.kind ?? 'all'],
    queryFn: () => searchApi.search(organizationId, q, search.kind ? [search.kind] : undefined),
    enabled: !!organizationId && q.length >= 2 && useKeyword,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Find"
        title="Search"
        description="Search meetings, transcripts, summaries and tasks in this organization."
      />
      <form
        role="search"
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSearchChange({ ...search, q: draft.trim() || undefined });
        }}
      >
        <label htmlFor="search-q" className="sr-only">
          Search
        </label>
        <Input
          id="search-q"
          type="search"
          className="min-h-11 flex-1"
          placeholder='e.g. billing migration, "launch date", roadmap -draft'
          maxLength={200}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" className="min-h-11">
          <Search aria-hidden />
          Search
        </Button>
      </form>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        <Button
          type="button"
          size="sm"
          variant={search.kind ? 'outline' : 'default'}
          aria-pressed={!search.kind}
          onClick={() => onSearchChange({ ...search, kind: undefined })}
        >
          All
        </Button>
        {SEARCH_RESULT_KINDS.map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant={search.kind === k ? 'default' : 'outline'}
            aria-pressed={search.kind === k}
            onClick={() => onSearchChange({ ...search, kind: k })}
          >
            {KIND_LABEL[k]}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={semanticOn ? 'default' : 'outline'}
          aria-pressed={semanticOn}
          onClick={() => setSemanticOn((v) => !v)}
        >
          <Sparkles aria-hidden />
          Semantic
        </Button>
      </div>
      {semanticOff ? (
        <p role="status" className="text-sm text-muted-foreground">
          Semantic search isn&apos;t enabled on this workspace. Showing keyword results.
        </p>
      ) : semanticOn && semKind === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Semantic search covers transcripts and summaries. Showing keyword results.
        </p>
      ) : null}
      {q.length >= 2 && !useKeyword ? (
        semantic.isError ? (
          <ErrorState error={semantic.error} onRetry={() => void semantic.refetch()} />
        ) : !semantic.data ? (
          <LoadingState />
        ) : semantic.data.items.length === 0 ? (
          <EmptyState title="No results" description={`Nothing matched “${q}”.`} />
        ) : (
          <ul aria-label="Semantic results" className="divide-y rounded-md border">
            {semantic.data.items.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <SemanticResultLink r={r} />
              </li>
            ))}
          </ul>
        )
      ) : q.length < 2 ? (
        <EmptyState title="Start typing" description="Enter at least two characters." />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : !result.data ? (
        <LoadingState />
      ) : result.data.items.length === 0 ? (
        <EmptyState title="No results" description={`Nothing matched “${q}”.`} />
      ) : (
        <ul aria-label="Search results" className="divide-y rounded-md border">
          {result.data.items.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <ResultLink r={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
