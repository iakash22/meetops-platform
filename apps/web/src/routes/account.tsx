import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

const AccountPage = lazyRouteComponent(
  () => import('@/features/account/account-page'),
  'AccountPage',
);

/**
 * /account (profile, sessions, log out everywhere). Mounted under the guarded app
 * layout by router.tsx, which passes the parent so this file needs no runtime import
 * of the router (no cycle).
 */
export function createAccountRoutes<TParent extends AnyRoute>(getParent: () => TParent) {
  return createRoute({
    getParentRoute: getParent,
    path: '/account',
    component: AccountPage,
  });
}
