import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { PageHeader } from '@/components/ui/typography';
import { isNotAvailable, useMarkRead, useNotifications } from './queries';
import { NEW_LOCATION_SIGNIN, notificationTitle, type Notification } from './api';

function Target({ n }: { n: Notification }) {
  if (n.kind === NEW_LOCATION_SIGNIN)
    return (
      <Link to="/account" className="text-link text-xs hover:underline">
        Review active sessions
      </Link>
    );
  if (n.meetingId)
    return (
      <Link
        to="/meetings/$meetingId"
        params={{ meetingId: n.meetingId }}
        className="text-link text-xs hover:underline"
      >
        Open meeting
      </Link>
    );
  if (n.taskId)
    return (
      <Link to="/tasks" className="text-link text-xs hover:underline">
        Open tasks
      </Link>
    );
  return null;
}

export function NotificationsPage() {
  const q = useNotifications();
  const mark = useMarkRead();
  const unread = q.data?.items.filter((n) => !n.readAt).length ?? 0;
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Meeting, transcript, summary and task updates"
        {...(unread > 0
          ? {
              actions: (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mark.isPending}
                  onClick={() => mark.mutate(undefined)}
                >
                  Mark all read
                </Button>
              ),
            }
          : {})}
      />
      {q.isPending ? (
        <LoadingState label="Loading notifications…" />
      ) : q.isError ? (
        isNotAvailable(q.error) ? (
          <EmptyState
            title="Notifications aren't available yet"
            description="In-app notifications are coming soon. Email notifications still work."
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : q.data.items.length === 0 ? (
        <EmptyState title="You're all caught up" />
      ) : (
        <ul className="divide-y rounded-xl border" aria-label="Notifications">
          {q.data.items.map((n) => (
            <li
              key={n.id}
              className="flex items-start justify-between gap-3 p-3"
              data-unread={!n.readAt}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  {/* Plain text only: may include AI-generated titles. */}
                  <span className="text-sm font-medium">{notificationTitle(n)}</span>
                  {!n.readAt ? <Badge>New</Badge> : null}
                </div>
                {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                <Target n={n} />
              </div>
              {!n.readAt ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Mark "${notificationTitle(n)}" read`}
                  disabled={mark.isPending}
                  onClick={() => mark.mutate(n.id)}
                >
                  Mark read
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {mark.isError ? (
        <ErrorState title="Couldn't update notifications" error={mark.error} />
      ) : null}
    </>
  );
}
