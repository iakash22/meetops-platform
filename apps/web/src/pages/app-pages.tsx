import { useMeetings, useProjects, useTasks } from '@/lib/api/queries';
import { EmptyState } from '@/components/states/states';
import { PageHeader, ResourceList } from './resource-list';

export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Your meetings, tasks and projects at a glance" />
      <EmptyState title="Nothing here yet" description="Connect a meeting source to get started." />
    </>
  );
}

export function MeetingsPage() {
  const query = useMeetings();
  return (
    <>
      <PageHeader title="Meetings" />
      <ResourceList
        query={query}
        emptyTitle="No meetings yet"
        emptyDescription="Meetings you record or import will appear here."
        renderItem={(m) => (
          <div className="flex justify-between">
            <span>{m.title}</span>
            <span className="text-sm text-muted-foreground">{m.status}</span>
          </div>
        )}
      />
    </>
  );
}

export function TasksPage() {
  const query = useTasks();
  return (
    <>
      <PageHeader title="Tasks" />
      <ResourceList
        query={query}
        emptyTitle="No tasks yet"
        renderItem={(t) => (
          <div className="flex justify-between">
            <span>{t.title}</span>
            <span className="text-sm text-muted-foreground">{t.status}</span>
          </div>
        )}
      />
    </>
  );
}

export function ProjectsPage() {
  const query = useProjects();
  return (
    <>
      <PageHeader title="Projects" />
      <ResourceList query={query} emptyTitle="No projects yet" renderItem={(p) => <span>{p.name}</span>} />
    </>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Organization and account settings" />
      <EmptyState title="Settings coming soon" />
    </>
  );
}
