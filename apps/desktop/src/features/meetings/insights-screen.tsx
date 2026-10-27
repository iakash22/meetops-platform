import type { Meeting, Report, Transcript } from '@meetops/contracts';
import { ArrowLeft, Clock } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ListError, ListLoading } from '@/features/data/list-states';
import { useDataSource } from '@/features/data/repositories';
import { isNotReady } from './native-insights-api';

type Tab = 'transcript' | 'report';
type Load<T> =
  | { status: 'loading' }
  | { status: 'not-ready' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T };

/** m:ss or h:mm:ss for transcript offsets. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function useInsight<T>(load: () => Promise<T>): { state: Load<T>; retry: () => void } {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (value) => live && setState({ status: 'ready', value }),
      (e: unknown) =>
        live &&
        setState(
          isNotReady(e)
            ? { status: 'not-ready' }
            : { status: 'error', message: e instanceof Error ? e.message : 'Could not load.' },
        ),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function NotReady({ what }: { what: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Clock className="size-4" aria-hidden />
      The {what} is not ready yet. It appears here once processing finishes.
    </p>
  );
}

function TranscriptView({ t }: { t: Transcript }) {
  if (t.segments.length === 0)
    return <p className="text-sm text-muted-foreground">This transcript is empty.</p>;
  return (
    <ol aria-label="Transcript" className="space-y-3">
      {t.segments.map((seg) => (
        <li key={seg.id} className="grid grid-cols-[4.5rem_1fr] gap-3 text-sm">
          <span className="tabular-nums text-muted-foreground">{formatOffset(seg.startMs)}</span>
          <p>
            {seg.speaker ? <span className="font-medium">{seg.speaker}: </span> : null}
            {seg.text}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Section({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}

function ReportView({ r }: { r: Report }) {
  const empty = !r.summary && !r.decisions.length && !r.risks.length && !r.actionItems.length;
  if (empty) return <p className="text-sm text-muted-foreground">This report has no content.</p>;
  return (
    <div className="space-y-5">
      {r.summary ? <p className="whitespace-pre-line text-sm">{r.summary}</p> : null}
      <Section title="Decisions" items={r.decisions} />
      <Section title="Risks" items={r.risks} />
      <Section
        title="Action items"
        items={r.actionItems.map((a) =>
          [a.title, a.assigneeHint && `(${a.assigneeHint})`, a.dueHint && `due ${a.dueHint}`]
            .filter(Boolean)
            .join(' '),
        )}
      />
    </div>
  );
}

function Panel<T>({
  what,
  load,
  render,
}: {
  what: string;
  load: () => Promise<T>;
  render: (v: T) => ReactNode;
}) {
  const { state, retry } = useInsight(load);
  if (state.status === 'loading') return <ListLoading label={what} />;
  if (state.status === 'not-ready') return <NotReady what={what} />;
  if (state.status === 'error') return <ListError message={state.message} onRetry={retry} />;
  return <>{render(state.value)}</>;
}

/** Transcript and report for one meeting (#212). 404 from the API means "not ready yet", not an error. */
export function InsightsScreen({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const { insights } = useDataSource();
  const [tab, setTab] = useState<Tab>('transcript');
  const loadTranscript = useCallback(
    () => insights.transcript(meeting.organizationId, meeting.id),
    [insights, meeting],
  );
  const loadReport = useCallback(
    () => insights.report(meeting.organizationId, meeting.id),
    [insights, meeting],
  );
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to meetings">
          <ArrowLeft aria-hidden />
        </Button>
        <h1 className="truncate text-2xl font-semibold tracking-tight">{meeting.title}</h1>
      </div>
      <div role="tablist" aria-label="Meeting insights" className="flex gap-2">
        {(['transcript', 'report'] as const).map((t) => (
          <Button
            key={t}
            role="tab"
            aria-selected={tab === t}
            variant={tab === t ? 'default' : 'outline'}
            onClick={() => setTab(t)}
          >
            {t === 'transcript' ? 'Transcript' : 'Report'}
          </Button>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{tab === 'transcript' ? 'Transcript' : 'Report'}</CardTitle>
        </CardHeader>
        <CardContent role="tabpanel">
          {tab === 'transcript' ? (
            <Panel
              key="transcript"
              what="transcript"
              load={loadTranscript}
              render={(t: Transcript) => <TranscriptView t={t} />}
            />
          ) : (
            <Panel
              key="report"
              what="report"
              load={loadReport}
              render={(r: Report) => <ReportView r={r} />}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
