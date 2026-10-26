import type { Meeting, MeetingStatus } from '@meetops/contracts';
import { Circle } from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SAMPLE_MEETINGS } from './sample-meetings';

const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_VARIANT: Record<MeetingStatus, NonNullable<BadgeProps['variant']>> = {
  scheduled: 'outline',
  recording: 'highlight',
  processing: 'default',
  completed: 'secondary',
  failed: 'destructive',
};

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function MeetingsScreen({
  meetings = SAMPLE_MEETINGS,
  onRecord,
}: {
  meetings?: readonly Meeting[];
  onRecord?: (() => void) | undefined;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
          <p className="text-sm text-muted-foreground">
            Placeholder data. Live meetings arrive with the desktop API commands.
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
          <CardDescription>{meetings.length} meetings</CardDescription>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
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
                  <Badge variant={STATUS_VARIANT[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
