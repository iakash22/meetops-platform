import { useProjects } from '@/lib/api/queries';
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

export function ProjectsPage() {
  const query = useProjects();
  return (
    <>
      <PageHeader title="Projects" />
      <ResourceList
        query={query}
        emptyTitle="No projects yet"
        renderItem={(p) => <span>{p.name}</span>}
      />
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
