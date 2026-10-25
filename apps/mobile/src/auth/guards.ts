import type { AuthState } from './sessionManager';

/** Route groups: `(auth)` holds sign-in screens, `(app)` everything that needs a session. */
export type RouteGroup = 'auth' | 'app';

export const SIGN_IN_ROUTE = '/login' as const;
export const HOME_ROUTE = '/' as const;

/**
 * Where a group layout must redirect for the given auth state, or null to render it.
 * While the session is being restored nothing is rendered or redirected (no flash of the wrong screen).
 */
export function guardRedirect(
  status: AuthState['status'],
  group: RouteGroup,
): typeof SIGN_IN_ROUTE | typeof HOME_ROUTE | null {
  if (status === 'loading') return null;
  if (group === 'app' && status === 'signedOut') return SIGN_IN_ROUTE;
  if (group === 'auth' && status === 'signedIn') return HOME_ROUTE;
  return null;
}
