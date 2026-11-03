import type { Meeting, MeetingStatus } from '@meetops/contracts';
import { Circle } from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDataSource } from '@/features/data/repositories';
import { ListError, ListLoading } from '@/features/data/list-states';
import { useOrgList } from '@/features/data/use-org-list';

const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  transcription_delayed: 'Transcription delayed',
};

/** Unknown statuses (a newer API than this client) render as a neutral "Unknown status". */
const UNKNOWN_STATUS_LABEL = 'Unknown status';
const statusLabel = (s: string) => STATUS_LABEL[s as Meeting['status']] ?? UNKNOWN_STATUS_LABEL;
const statusVariant = (s: string) => STATUS_VARIANT[s as Meeting['status']] ?? 'outline';

const STATUS_VARIANT: Record<MeetingStatus, NonNullable<BadgeProps['variant']>> = {
  scheduled: 'outline',
  recording: 'default',
  processing: 'default',
  completed: 'secondary',
  failed: 'destructive',
  transcription_delayed: 'secondary',
};

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function MeetingsScreen({
  onRecord,
  onOpen,
}: { onRecord?: (() => void) | undefined; onOpen?: ((m: Meeting) => void) | undefined } = {}) {
  const data = useDataSource();
  const { state, retry } = useOrgList(data.listMeetings);
  const meetings: readonly Meeting[] = state.status === 'ready' ? state.items : [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
          <p className="text-sm text-muted-foreground">
            {data.sample
              ? 'Sample data. Live meetings load once you sign in with your browser.'
              : 'Meetings in your active organization.'}
          </p>
        </div>
        <Button variant="record" onClick={onRecord} disabled={!onRecord}>
          <Circle className="fill-current" aria-hidden />
          New offline recording
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent meetings</CardTitle>
          <CardDescription>
            {state.status === 'ready' ? `${meetings.length} meetings` : '\u00a0'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === 'loading' ? (
            <ListLoading label="meetings" />
          ) : state.status === 'error' ? (
            <ListError message={state.message} onRetry={retry} />
          ) : meetings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No meetings yet.</p>
          ) : (
            <ul aria-label="Meetings" className="divide-y divide-border">
              {meetings.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(m.startedAt ?? m.createdAt)} · {m.source}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge variant={statusVariant(m.status)}>{statusLabel(m.status)}</Badge>
                    {onOpen ? (
                      <Button variant="outline" size="sm" onClick={() => onOpen(m)}>
                        Transcript &amp; report
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
