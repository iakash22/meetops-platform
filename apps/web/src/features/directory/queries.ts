import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { useSession } from '@/features/session/use-session';
import type {
  CursorPage,
  Id,
  ListEmployeesQuery,
  ListProjectsQuery,
  ListTeamsQuery,
} from './contracts-shim';

/** Every key lives under ['orgs', orgId] so a 401 / org switch clears it with the rest. */
export const directoryKeys = {
  employees: (orgId: Id) => ['orgs', orgId, 'directory', 'employees'] as const,
  employeeList: (orgId: Id, q: ListEmployeesQuery) =>
    [...directoryKeys.employees(orgId), 'list', q] as const,
  teams: (orgId: Id) => ['orgs', orgId, 'directory', 'teams'] as const,
  teamList: (orgId: Id, q: ListTeamsQuery) => [...directoryKeys.teams(orgId), 'list', q] as const,
  team: (orgId: Id, teamId: Id) => [...directoryKeys.teams(orgId), 'detail', teamId] as const,
  teamMembers: (orgId: Id, teamId: Id) =>
    [...directoryKeys.teams(orgId), 'members', teamId] as const,
  projects: (orgId: Id) => ['orgs', orgId, 'directory', 'projects'] as const,
  projectList: (orgId: Id, q: ListProjectsQuery) =>
    [...directoryKeys.projects(orgId), 'list', q] as const,
};

/** Add the page cursor only when there is one (exactOptionalPropertyTypes). */
function withCursor<Q extends object>(q: Q, cursor: string | undefined): Q & { cursor?: string } {
  return cursor ? { ...q, cursor } : q;
}

const nextCursor = <T>(last: CursorPage<T>) => last.nextCursor ?? undefined;

/** Flatten infinite cursor pages into one list. */
export function flatItems<T>(data: InfiniteData<CursorPage<T>> | undefined): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

/**
 * Keep the previous page set while a search/filter changes, but never across
 * organizations: another org's rows must not flash under the new org.
 */
function sameOrgPlaceholder(orgId: Id) {
  return <T>(prev: T | undefined, prevQuery?: { queryKey: readonly unknown[] }): T | undefined =>
    prevQuery?.queryKey[1] === orgId ? prev : undefined;
}

export function useEmployees(q: ListEmployeesQuery = {}) {
  const { directory } = useApi();
  const orgId = useOrganizationId();
  return useInfiniteQuery({
    queryKey: directoryKeys.employeeList(orgId, q),
    placeholderData: sameOrgPlaceholder(orgId),
    queryFn: ({ pageParam }) => directory.employees.list(orgId, withCursor(q, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!orgId,
  });
}

export function useTeams(q: ListTeamsQuery = {}) {
  const { directory } = useApi();
  const orgId = useOrganizationId();
  return useInfiniteQuery({
    queryKey: directoryKeys.teamList(orgId, q),
    placeholderData: sameOrgPlaceholder(orgId),
    queryFn: ({ pageParam }) => directory.teams.list(orgId, withCursor(q, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!orgId,
  });
}

export function useTeam(teamId: Id) {
  const { directory } = useApi();
  const orgId = useOrganizationId();
  return useQuery({
    queryKey: directoryKeys.team(orgId, teamId),
    queryFn: () => directory.teams.get(orgId, teamId),
    enabled: !!orgId && !!teamId,
  });
}

export function useTeamMembers(teamId: Id) {
  const { directory } = useApi();
  const orgId = useOrganizationId();
  return useInfiniteQuery({
    queryKey: directoryKeys.teamMembers(orgId, teamId),
    queryFn: ({ pageParam }) =>
      directory.teamMembers.list(orgId, teamId, withCursor({}, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!orgId && !!teamId,
  });
}

export function useProjectList(q: ListProjectsQuery = {}) {
  const { directory } = useApi();
  const orgId = useOrganizationId();
  return useInfiniteQuery({
    queryKey: directoryKeys.projectList(orgId, q),
    placeholderData: sameOrgPlaceholder(orgId),
    queryFn: ({ pageParam }) => directory.projects.list(orgId, withCursor(q, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    enabled: !!orgId,
  });
}

/**
 * Mutation scoped to the current org that invalidates the given directory key prefixes on success.
 * The org id is captured when the mutation runs, so an org switch mid-flight never writes elsewhere.
 */
export function useDirectoryMutation<V, R>(
  fn: (orgId: Id, vars: V) => Promise<R>,
  invalidate: (orgId: Id) => ReadonlyArray<readonly unknown[]>,
) {
  const orgId = useOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => fn(orgId, vars),
    onSuccess: () =>
      Promise.all(invalidate(orgId).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}

/**
 * Owner/admin of the current org see write controls. UI hint only: the API enforces CASL (BE-2).
 * The session role applies to the session's active org, so a mismatch shows read-only UI.
 */
export function useCanManageDirectory(): boolean {
  const { data } = useSession();
  const orgId = useOrganizationId();
  if (!data || data.activeOrganizationId !== orgId) return false;
  return data.role === 'owner' || data.role === 'admin';
}
