import { createRoute, lazyRouteComponent, useSearch, type AnyRoute } from '@tanstack/react-router';
import { useOrganizationId } from '@/lib/api/queries';

const MembersPage = lazyRouteComponent(
  () => import('@/features/members/members-page'),
  'MembersPage',
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `org` is optional (defaults to the active org). Anything that isn't a UUID is kept
// as `invalid` so the page shows not-found instead of silently using another org.
// Invalid values map to an explicit `undefined` key: the router merges the raw search.
export type MembersSearch = { org?: string | undefined };
export function parseMembersSearch(search: Record<string, unknown>): MembersSearch {
  if (search.org === undefined) return { org: undefined };
  return { org: typeof search.org === 'string' && search.org ? search.org : 'invalid' };
}

/** /organization/members, under the guarded app layout (see createAccountRoutes). */
export function createOrganizationRoutes<TParent extends AnyRoute>(getParent: () => TParent) {
  return createRoute({
    getParentRoute: getParent,
    path: '/organization/members',
    validateSearch: parseMembersSearch,
    component: function MembersRoute() {
      // Non-strict read: the parent is generic here, so the route's own search type is opaque.
      const { org } = parseMembersSearch(useSearch({ strict: false }));
      const activeId = useOrganizationId();
      const invalid = org !== undefined && !UUID.test(org);
      return (
        <MembersPage
          organizationId={invalid ? undefined : (org ?? (activeId || undefined))}
          invalidOrganization={invalid}
        />
      );
    },
  });
}
