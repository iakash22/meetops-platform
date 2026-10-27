import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOrgStore } from '@/stores/org-store';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { useMeetings, useTasks } from '@/lib/api/queries';
import { PageHeader } from './resource-list';

const RECENT = 5;

function RecentMeetings() {
  const q = useMeetings();
  if (q.isPending) return <LoadingState label="Loading meetings…" rows={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items).slice(0, RECENT);
  if (items.length === 0)
    return <EmptyState title="No meetings yet" description="Upload or record a meeting." />;
  return (
    <ul className="divide-y" aria-label="Recent meetings">
      {items.map((m) => (
        <li key={m.id} className="flex items-center justify-between gap-2 py-2">
          <Link
            to="/meetings/$meetingId"
            params={{ meetingId: m.id }}
            className="truncate text-sm hover:underline"
          >
            {m.title}
          </Link>
          <Badge variant="secondary">{m.status}</Badge>
        </li>
      ))}
    </ul>
  );
}

function OpenTasks() {
  const q = useTasks({ status: 'todo' });
  if (q.isPending) return <LoadingState label="Loading tasks…" rows={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.items.slice(0, RECENT);
  if (items.length === 0) return <EmptyState title="No open tasks" />;
  return (
    <ul className="divide-y" aria-label="Open tasks">
      {items.map((t) => (
        <li key={t.id} className="py-2 text-sm">
          {/* Plain text: titles may be AI-generated and are untrusted. */}
          {t.title}
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const hasOrganizations = useOrgStore((s) => s.organizations.length > 0);
  return (
    <>
      <PageHeader title="Dashboard" description="Your meetings, tasks and projects at a glance" />
      {hasOrganizations ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Recent meetings</CardTitle>
              <Link to="/meetings" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                View all
              </Link>
            </CardHeader>
            <CardContent>
              <RecentMeetings />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Open tasks</CardTitle>
              <Link to="/tasks" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                View all
              </Link>
            </CardHeader>
            <CardContent>
              <OpenTasks />
            </CardContent>
          </Card>
        </div>
      ) : (
        <EmptyState
          title="You don't belong to an organization yet"
          description="Create one to start uploading meetings."
          action={
            <Link to="/organizations/new" className={buttonVariants()}>
              Create organization
            </Link>
          }
        />
      )}
    </>
  );
}
