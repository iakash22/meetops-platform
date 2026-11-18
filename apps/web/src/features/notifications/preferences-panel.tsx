import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import {
  KNOWN_NOTIFICATION_KINDS,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationPreference,
} from './api';
import {
  isNotAvailable,
  useNotificationPreferences,
  useSaveNotificationPreferences,
} from './queries';

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
  web_push: 'Web push',
  mobile_push: 'Mobile push',
  desktop: 'Desktop',
};
const TYPE_LABEL: Record<string, string> = {
  '*': 'All notifications',
  'meeting.processed': 'Meeting processed',
  'transcript.ready': 'Transcript ready',
  'report.ready': 'AI summary ready',
  'task.assigned': 'Task assigned',
  'task.updated': 'Task updated',
  'auth.new_location_signin': 'New sign-in location',
};
const TYPES = ['*', ...KNOWN_NOTIFICATION_KINDS] as const;

type Matrix = Record<string, Record<NotificationChannel, boolean>>;
const key = (type: string, channel: string) => `${type}|${channel}`;

/** Missing rows default to the '*' row for that channel, then to enabled. */
export function toMatrix(items: NotificationPreference[]): Matrix {
  const m = new Map(items.map((p) => [key(p.type, p.channel), p.enabled]));
  const out: Matrix = {};
  for (const t of TYPES) {
    out[t] = {} as Record<NotificationChannel, boolean>;
    for (const c of NOTIFICATION_CHANNELS)
      out[t][c] = m.get(key(t, c)) ?? m.get(key('*', c)) ?? true;
  }
  return out;
}

export function fromMatrix(m: Matrix): NotificationPreference[] {
  return TYPES.flatMap((type) =>
    NOTIFICATION_CHANNELS.map((channel) => ({ type, channel, enabled: m[type]![channel] })),
  );
}

export function NotificationPreferencesPanel() {
  const q = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  useEffect(() => {
    if (q.data) setMatrix(toMatrix(q.data.items));
  }, [q.data]);

  if (q.isPending) return <LoadingState label="Loading notification preferences…" />;
  if (q.isError)
    return isNotAvailable(q.error) ? (
      <EmptyState
        title="Notification preferences aren't available yet"
        description="This server doesn't support notification preferences."
      />
    ) : (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    );
  if (!matrix) return null;

  const toggle = (t: string, c: NotificationChannel) =>
    setMatrix((m) => (m ? { ...m, [t]: { ...m[t]!, [c]: !m[t]![c] } } : m));

  return (
    <form
      aria-label="Notification preferences"
      onSubmit={(e) => {
        e.preventDefault();
        const lastSaved = q.data;
        save.mutate(
          { items: fromMatrix(matrix) },
          {
            onError: () => {
              if (lastSaved) setMatrix(toMatrix(lastSaved.items));
            },
          },
        );
      }}
      className="space-y-4"
    >
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="p-3 font-medium">
                Notification
              </th>
              {NOTIFICATION_CHANNELS.map((c) => (
                <th key={c} scope="col" className="p-3 text-center font-medium">
                  {CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TYPES.map((t) => (
              <tr key={t} className="border-b last:border-0">
                <th scope="row" className="p-3 text-left font-normal">
                  {TYPE_LABEL[t]}
                </th>
                {NOTIFICATION_CHANNELS.map((c) => (
                  <td key={c} className="p-3 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      aria-label={`${TYPE_LABEL[t]} via ${CHANNEL_LABEL[c]}`}
                      checked={matrix[t]![c]}
                      onChange={() => toggle(t, c)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save preferences'}
        </Button>
        {save.isSuccess ? (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>
      {save.isError ? <ErrorState title="Couldn't save preferences" error={save.error} /> : null}
    </form>
  );
}
