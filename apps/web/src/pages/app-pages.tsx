import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button';
import { useOrgStore } from '@/stores/org-store';
import { useProjects } from '@/lib/api/queries';
import { EmptyState } from '@/components/states/states';
import { PageHeader, ResourceList } from './resource-list';

export function DashboardPage() {
  const hasOrganizations = useOrgStore((s) => s.organizations.length > 0);
  return (
    <>
      <PageHeader title="Dashboard" description="Your meetings, tasks and projects at a glance" />
      {hasOrganizations ? (
        <EmptyState
          title="Nothing here yet"
          description="Connect a meeting source to get started."
        />
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
