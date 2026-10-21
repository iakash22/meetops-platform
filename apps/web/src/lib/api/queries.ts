import { useQuery } from '@tanstack/react-query';
import type { Id, Meeting, Paginated, Task, TaskUpdateEvent } from '@meetops/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { useApi } from './context';
import type { TaskListFilters } from './client';
import { useOrgStore } from '@/stores/org-store';

export const queryKeys = {
  session: ['session'] as const,
  organizations: ['organizations'] as const,
  meetings: (organizationId: Id) => ['orgs', organizationId, 'meetings'] as const,
  meeting: (organizationId: Id, meetingId: Id) =>
    ['orgs', organizationId, 'meetings', meetingId] as const,
  tasks: (organizationId: Id, filters: TaskListFilters = {}) =>
    ['orgs', organizationId, 'tasks', filters] as const,
  projects: (organizationId: Id) => ['orgs', organizationId, 'projects'] as const,
};

export function useOrganizationId(): Id {
  return useOrgStore((s) => s.currentOrganizationId) ?? '';
}

export function useMeetings() {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.meetings(organizationId),
    queryFn: () => api.meetings.list(organizationId),
    enabled: !!organizationId,
  });
}

export function useMeeting(meetingId: Id) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery<Meeting>({
    queryKey: queryKeys.meeting(organizationId, meetingId),
    queryFn: () => api.meetings.get(organizationId, meetingId),
    enabled: !!organizationId && !!meetingId,
  });
}

export function useTasks(filters: TaskListFilters = {}) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.tasks(organizationId, filters),
    queryFn: () => api.tasks.list(organizationId, filters),
    enabled: !!organizationId,
  });
}

export function useProjects() {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.projects(organizationId),
    queryFn: () => api.projects.list(organizationId),
    enabled: !!organizationId,
  });
}

/**
 * Merge a realtime `task.updated` event into every cached task page for that org.
 * Values are stored as plain data and rendered as text by React (never as HTML).
 */
export function applyTaskUpdate(queryClient: QueryClient, event: TaskUpdateEvent): void {
  queryClient.setQueriesData<Paginated<Task>>(
    { queryKey: ['orgs', event.organizationId, 'tasks'] },
    (page) =>
      page && {
        ...page,
        items: page.items.map((t) =>
          t.id === event.taskId
            ? {
                ...t,
                status: event.status,
                ...(event.title !== undefined ? { title: event.title } : {}),
                ...(event.assigneeId !== undefined ? { assigneeId: event.assigneeId } : {}),
              }
            : t,
        ),
      },
  );
}
