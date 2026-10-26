import { memo, useDeferredValue, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Meeting } from '@meetops/contracts';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { useMeeting, useMeetings } from '@/lib/api/queries';
import { PageHeader } from '@/pages/resource-list';
import { ReportPanel, TranscriptPanel } from './insights-panels';
import { UploadButton } from './upload-button';
import { filterMeetings, type MeetingFilters } from './manage-api';
import { MeetingFormDialog } from './meeting-form';
import { Input } from '@/components/ui/input';
import { RecordingPanel } from '@/features/recording/recording-panel';

const STATUS_LABEL: Record<Meeting['status'], string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_VARIANT: Record<Meeting['status'], NonNullable<BadgeProps['variant']>> = {
  scheduled: 'outline',
  recording: 'live',
  processing: 'secondary',
  completed: 'default',
  failed: 'destructive',
};

const SOURCE_LABEL: Record<Meeting['source'], string> = {
  upload: 'Upload',
  extension: 'Browser extension',
  desktop: 'Desktop app',
  bot: 'Meeting bot',
};

export function MeetingStatusBadge({ status }: { status: Meeting['status'] }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-testid="meeting-status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Rows are memoised: loading another page appends items without re-rendering existing rows.
const MeetingRow = memo(function MeetingRow({ meeting: m }: { meeting: Meeting }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3">
      <Link
        to="/meetings/$meetingId"
        params={{ meetingId: m.id }}
        className="inline-flex min-h-11 items-center font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.title}
      </Link>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <time dateTime={m.startedAt ?? m.createdAt}>{formatDate(m.startedAt ?? m.createdAt)}</time>
        <MeetingStatusBadge status={m.status} />
      </div>
    </li>
  );
});

export function MeetingsPage() {
  const query = useMeetings();
  const [filters, setFilters] = useState<MeetingFilters>({ q: '', status: '' });
  const deferred = useDeferredValue(filters);
  const filtering = deferred.q.trim() !== '' || deferred.status !== '';
  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // Search and status filter apply to the pages loaded so far; "Load more" keeps fetching.
  const items = useMemo(
    () => (filtering ? filterMeetings(all, deferred) : all),
    [all, deferred, filtering],
  );
  let body;
  if (query.isError && all.length === 0)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (query.isPending && query.fetchStatus !== 'idle') body = <LoadingState />;
  else if (items.length === 0)
    body = (
      <EmptyState
        title={filtering ? 'No matching meetings' : 'No meetings yet'}
        description={
          filtering
            ? 'Try a different search or status.'
            : 'Meetings you record or import will appear here.'
        }
      />
    );
  else
    body = (
      <>
        <ul className="divide-y rounded-lg border" aria-label="Meetings">
          {items.map((m) => (
            <MeetingRow key={m.id} meeting={m} />
          ))}
        </ul>
        {query.isFetchNextPageError ? (
          <ErrorState
            title="Couldn't load more meetings"
            error={query.error}
            onRetry={() => void query.fetchNextPage()}
          />
        ) : null}
        {query.hasNextPage && !query.isFetchNextPageError ? (
          <Button
            variant="outline"
            className="min-h-11 self-center"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </>
    );
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Meetings" />
        <div className="flex items-start gap-2">
          <MeetingFormDialog />
          <UploadButton />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-2" role="search">
        <Input
          type="search"
          aria-label="Search meetings"
          placeholder="Search meetings"
          maxLength={200}
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          className="h-11 max-w-xs"
        />
        <select
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) =>
            setFilters((f) => ({ ...f, status: e.target.value as MeetingFilters['status'] }))
          }
          className="h-11 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as Meeting['status'][]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-4" aria-busy={query.isFetchingNextPage}>
        {body}
      </div>
    </>
  );
}

export function MeetingDetailPage({ meetingId }: { meetingId: string }) {
  const query = useMeeting(meetingId);
  if (query.isError) {
    // The API returns the same 404 for missing and other-organization meetings.
    if (query.error instanceof ApiError && query.error.status === 404)
      return (
        <div className="flex flex-col gap-4">
          <ErrorState title="Meeting not found" error={query.error} />
          <Link
            to="/meetings"
            className="inline-flex min-h-11 w-fit items-center text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to meetings
          </Link>
        </div>
      );
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.data) return <LoadingState />;
  const m = query.data;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDate(m.startedAt)} – {formatDate(m.endedAt)} · {SOURCE_LABEL[m.source]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <MeetingStatusBadge status={m.status} />
          <MeetingFormDialog meeting={m} />
          <UploadButton meetingId={m.id} />
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Record</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RecordingPanel meetingId={m.id} />
        </CardContent>
      </Card>
      <ReportPanel meetingId={m.id} ready={m.status === 'completed'} />
      <TranscriptPanel meetingId={m.id} ready={m.status === 'completed'} />
    </div>
  );
}
