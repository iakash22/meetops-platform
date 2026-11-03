import { useMemo, useState } from 'react';
import type { MeetingAnalytics } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/typography';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import {
  RANGE_PRESETS,
  SOURCE_LABELS,
  STATUS_LABELS,
  formatDuration,
  periodLabel,
  rangeFor,
  type RangePresetId,
} from './api';
import { canViewAnalytics } from './permissions';
import { isNotAvailable, useMeetingAnalytics } from './queries';
import { useSession } from '@/features/session/use-session';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums" data-testid={`stat-${label}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/** Horizontal bars; widths are relative to the largest row. Plain HTML, no chart dependency. */
function BarList({
  title,
  rows,
}: {
  title: string;
  rows: ReadonlyArray<{ key: string; label: string; count: number }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data</p>
        ) : (
          <ul className="space-y-2" aria-label={title}>
            {rows.map((r) => (
              <li key={r.key} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{r.label}</span>
                  <span className="tabular-nums">{r.count}</span>
                </div>
                <div className="h-2 rounded bg-muted" aria-hidden>
                  <div
                    className="h-2 rounded bg-primary motion-safe:transition-all"
                    style={{ width: `${(r.count / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function AnalyticsDashboard({ data }: { data: MeetingAnalytics }) {
  const bySource = data.bySource
    .filter((r) => r.count > 0)
    .map((r) => ({ key: r.source, label: SOURCE_LABELS[r.source] ?? r.source, count: r.count }));
  const byStatus = data.byStatus
    .filter((r) => r.count > 0)
    .map((r) => ({
      key: r.status,
      label: STATUS_LABELS[r.status] ?? 'Unknown status',
      count: r.count,
    }));
  const periods = data.periods.map((p) => ({
    key: p.start,
    label: periodLabel(p.start, data.bucket),
    count: p.count,
  }));
  return (
    <div className="space-y-4" data-testid="analytics-dashboard">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Meetings" value={String(data.total)} />
        <Stat label="Total duration" value={formatDuration(data.duration.totalSec)} />
        <Stat label="Average duration" value={formatDuration(data.duration.averageSec)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Duration covers {data.duration.measured} of {data.total} meetings with a recorded length.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <BarList title="By source" rows={bySource} />
        <BarList title="By status" rows={byStatus} />
      </div>
      <BarList title={`Meetings per ${data.bucket}`} rows={periods} />
    </div>
  );
}

export function AnalyticsPage() {
  const [range, setRange] = useState<RangePresetId>('30d');
  const query = useMemo(() => rangeFor(range), [range]);
  const { data: session } = useSession();
  // Same check as the nav entry (nav-items.ts), so a role without the entry gets no request either.
  const allowed = canViewAnalytics(session?.role ?? null);
  const q = useMeetingAnalytics(query, { enabled: allowed });
  if (session && !allowed) {
    return (
      <>
        <PageHeader title="Analytics" description="Meeting activity for this organization (UTC)" />
        <EmptyState
          title="Analytics aren't available"
          description="Join or create an organization to see its meeting analytics."
        />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Meeting activity for this organization (UTC)"
        actions={
          <div role="group" aria-label="Date range" className="flex flex-wrap gap-1">
            {RANGE_PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === range ? 'default' : 'outline'}
                aria-pressed={p.id === range}
                onClick={() => setRange(p.id)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        }
      />
      {q.isPending ? (
        <LoadingState label="Loading analytics…" />
      ) : q.isError ? (
        isNotAvailable(q.error) ? (
          <EmptyState
            title="Analytics aren't available yet"
            description="This workspace doesn't have meeting analytics enabled."
          />
        ) : (
          <ErrorState
            title="Couldn't load analytics"
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        )
      ) : q.data.total === 0 ? (
        <EmptyState
          title="No meetings in this range"
          description="Record or upload a meeting, or pick a longer date range."
        />
      ) : (
        <AnalyticsDashboard data={q.data} />
      )}
    </>
  );
}
