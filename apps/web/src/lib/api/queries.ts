import { useQuery } from '@tanstack/react-query';
import { useApi } from './context';
import { useOrgStore } from '@/stores/org-store';

export const queryKeys = {
  organizations: ['organizations'] as const,
  meetings: (orgId: string) => ['orgs', orgId, 'meetings'] as const,
  tasks: (orgId: string) => ['orgs', orgId, 'tasks'] as const,
  projects: (orgId: string) => ['orgs', orgId, 'projects'] as const,
};

function useOrgId(): string {
  return useOrgStore((s) => s.currentOrgId) ?? '';
}

export function useMeetings() {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.meetings(orgId),
    queryFn: () => api.meetings.list(orgId),
    enabled: !!orgId,
  });
}

export function useTasks() {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.tasks(orgId),
    queryFn: () => api.tasks.list(orgId),
    enabled: !!orgId,
  });
}

export function useProjects() {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.projects(orgId),
    queryFn: () => api.projects.list(orgId),
    enabled: !!orgId,
  });
}
