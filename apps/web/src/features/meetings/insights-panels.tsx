import { memo, useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Id, Report, Transcript } from '@meetops/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { formatOffset } from './insights-api';

const notReady = (err: unknown) => err instanceof ApiError && err.status === 404;

function useInsight<T>(kind: 'transcript' | 'report', meetingId: Id, enabled: boolean) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery<T | null>({
    queryKey: ['orgs', organizationId, 'meetings', meetingId, kind],
    enabled: Boolean(organizationId) && enabled,
    staleTime: 60_000,
    // 404 = not produced yet (or route not shipped): show the empty state, don't retry.
    retry: (count, err) => !notReady(err) && count < 2,
    queryFn: async () => {
      try {
        return (await api.meetingInsights[kind](organizationId, meetingId)) as T;
      } catch (err) {
        if (notReady(err)) return null;
        throw err;
      }
    },
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-semibold text-muted-foreground">{label}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
    </section>
  );
}

export function ReportPanel({ meetingId, ready }: { meetingId: Id; ready: boolean }) {
  const q = useInsight<Report>('report', meetingId, ready);
  let body: React.ReactNode;
  if (!ready || q.data === null)
    body = (
      <EmptyState
        title="Summary not available yet"
        description="It will appear after processing completes."
      />
    );
  else if (q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (!q.data) body = <LoadingState rows={2} />;
  else {
    const r = q.data;
    body = (
      <div className="space-y-5">
        {/* Untrusted LLM output: rendered as text only, never as HTML. */}
        <p className="whitespace-pre-line text-sm leading-relaxed">{r.summary}</p>
        <List label="Decisions" items={r.decisions} />
        <List label="Risks" items={r.risks} />
        {r.actionItems.length > 0 ? (
          <section aria-label="Action items" className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">Action items</h3>
            <ul className="space-y-2 text-sm">
              {r.actionItems.map((a, i) => (
                <li key={i} className="rounded-lg border px-3 py-2">
                  <span className="font-medium">{a.title}</span>
                  {a.assigneeHint || a.dueHint ? (
                    <span className="block text-xs text-muted-foreground">
                      {[a.assigneeHint, a.dueHint].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }
  return <Section title="Summary">{body}</Section>;
}

const Segment = memo(function Segment({ s }: { s: Transcript['segments'][number] }) {
  return (
    <li className="grid grid-cols-[4.5rem_1fr] gap-3 py-2 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_2.5rem]">
      <time className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatOffset(s.startMs)}
      </time>
      <p>
        {s.speaker ? <span className="mr-2 font-semibold text-link">{s.speaker}</span> : null}
        {s.text}
      </p>
    </li>
  );
});

export function TranscriptPanel({ meetingId, ready }: { meetingId: Id; ready: boolean }) {
  const q = useInsight<Transcript>('transcript', meetingId, ready);
  const [filter, setFilter] = useState('');
  const deferred = useDeferredValue(filter.trim().toLowerCase());
  const segments = useMemo(() => {
    const all = q.data ? [...q.data.segments].sort((a, b) => a.index - b.index) : [];
    if (!deferred) return all;
    return all.filter(
      (s) => s.text.toLowerCase().includes(deferred) || s.speaker?.toLowerCase().includes(deferred),
    );
  }, [q.data, deferred]);

  let body: React.ReactNode;
  if (!ready || q.data === null)
    body = (
      <EmptyState
        title="Transcript not available yet"
        description="It will appear after transcription completes."
      />
    );
  else if (q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (!q.data) body = <LoadingState rows={4} />;
  else
    body = (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="transcript-filter">Search transcript</Label>
          <Input
            id="transcript-filter"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a word or speaker"
          />
        </div>
        {segments.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No lines match.
          </p>
        ) : (
          <ol aria-label="Transcript" className="max-h-[32rem] divide-y overflow-y-auto pr-2">
            {segments.map((s) => (
              <Segment key={s.id} s={s} />
            ))}
          </ol>
        )}
      </div>
    );
  return <Section title="Transcript">{body}</Section>;
}
