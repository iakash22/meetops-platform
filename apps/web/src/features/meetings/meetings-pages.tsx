import { memo, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { Meeting } from '@meetops/contracts';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { useMeeting, useMeetings } from '@/lib/api/queries';
import { PageHeader } from '@/pages/resource-list';
import { ReportPanel, TranscriptPanel } from './insights-panels';
import { UploadButton } from './upload-button';

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
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  let body;
  if (query.isError && items.length === 0)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (query.isPending && query.fetchStatus !== 'idle') body = <LoadingState />;
  else if (items.length === 0)
    body = (
      <EmptyState
        title="No meetings yet"
        description="Meetings you record or import will appear here."
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
      <div className="flex items-start justify-between">
        <PageHeader title="Meetings" />
        <UploadButton />
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
          <UploadButton meetingId={m.id} />
        </div>
      </div>
      <ReportPanel meetingId={m.id} ready={m.status === 'completed'} />
      <TranscriptPanel meetingId={m.id} ready={m.status === 'completed'} />
    </div>
  );
}
