import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Meeting } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { useMeeting, useMeetings } from '@/lib/api/queries';
import { PageHeader, ResourceList } from '@/pages/resource-list';
import { UploadButton } from './upload-button';
import { filterMeetings, type MeetingFilters } from './manage-api';
import { MeetingFormDialog } from './meeting-form';
import { Input } from '@/components/ui/input';

const STATUS_LABEL: Record<Meeting['status'], string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

export function MeetingStatusBadge({ status }: { status: Meeting['status'] }) {
  return (
    <Badge variant={status === 'failed' ? 'destructive' : 'secondary'} data-testid="meeting-status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function MeetingsPage() {
  const query = useMeetings();
  const [filters, setFilters] = useState<MeetingFilters>({ q: '', status: '' });
  const deferred = useDeferredValue(filters);
  const filtering = deferred.q.trim() !== '' || deferred.status !== '';
  const filtered = useMemo(
    () =>
      query.data && filtering
        ? { ...query.data, items: filterMeetings(query.data.items, deferred) }
        : query.data,
    [query.data, deferred, filtering],
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
      <ResourceList
        query={filtered === query.data ? query : ({ ...query, data: filtered } as typeof query)}
        emptyTitle={filtering ? 'No matching meetings' : 'No meetings yet'}
        emptyDescription={
          filtering
            ? 'Try a different search or status.'
            : 'Meetings you record or import will appear here.'
        }
        renderItem={(m) => (
          <div className="flex items-center justify-between gap-4">
            <Link
              to="/meetings/$meetingId"
              params={{ meetingId: m.id }}
              className="font-medium hover:underline"
            >
              {m.title}
            </Link>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>{formatDate(m.startedAt)}</span>
              <MeetingStatusBadge status={m.status} />
            </div>
          </div>
        )}
      />
    </>
  );
}

export function MeetingDetailPage({ meetingId }: { meetingId: string }) {
  const query = useMeeting(meetingId);
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  const m = query.data;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDate(m.startedAt)} – {formatDate(m.endedAt)} · {m.source}
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
            <h2>Summary</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="Summary not available yet"
            description="It will appear after processing completes."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Transcript</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="Transcript not available yet"
            description="It will appear after transcription completes."
          />
        </CardContent>
      </Card>
    </div>
  );
}
