import { Link } from '@tanstack/react-router';
import type { Meeting } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { useMeeting, useMeetings } from '@/lib/api/queries';
import { PageHeader, ResourceList } from '@/pages/resource-list';
import { UploadButton } from './upload-button';

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
  return (
    <>
      <div className="flex items-start justify-between">
        <PageHeader title="Meetings" />
        <UploadButton />
      </div>
      <ResourceList
        query={query}
        emptyTitle="No meetings yet"
        emptyDescription="Meetings you record or import will appear here."
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
