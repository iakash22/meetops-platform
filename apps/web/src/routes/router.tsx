import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AuthSession, GetAuthSessionResponse } from '@meetops/contracts';
import { AppShell } from '@/components/layout/app-shell';
import { EmptyState, ErrorState } from '@/components/states/states';
import { lazy, Suspense, useEffect } from 'react';
import { AuthLayout } from '@/features/auth/auth-layout';
import {
  applySessionToStore,
  ensureSession,
  isAuthOrUnavailable,
  useSession,
} from '@/features/session/use-session';
import { parseTaskSearch } from '@/features/tasks/task-search';
import { useApi } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/queries';
import { safeRedirect } from '@/lib/safe-redirect';
import { parseSettingsSearch } from '@/features/settings/settings-search';
import { parsePairSearch } from '@/features/extension/pairing';
import { parseDesktopAuthorizeSearch } from '@/features/desktop/authorize';

/** Rarely visited (only from the desktop app's sign-in), so it ships as its own chunk. */
const DesktopAuthorizePage = lazy(() =>
  import('@/features/desktop/authorize-page').then((m) => ({ default: m.DesktopAuthorizePage })),
);
import { createAuthPublicRoutes } from './auth-public';
import { createAccountRoutes } from './account';
import { createOrganizationRoutes } from './organization';
import { createTaskReviewRoutes } from './task-review';
import { RoutePending } from './route-pending';

/*
 * Route-level code splitting (docs/05-web/performance.md): every page module is its own
 * chunk, fetched on navigation or on link hover/focus (defaultPreload: 'intent'). Layouts,
 * guards and search parsers stay in the entry so redirects never wait on a page chunk.
 */
const LoginForm = lazyRouteComponent(() => import('@/features/auth/forms'), 'LoginForm');
const SignupForm = lazyRouteComponent(() => import('@/features/auth/forms'), 'SignupForm');
const ForgotPasswordForm = lazyRouteComponent(
  () => import('@/features/auth/forms'),
  'ForgotPasswordForm',
);
const meetingsModule = () => import('@/features/meetings/meetings-pages');
const MeetingsPage = lazyRouteComponent(meetingsModule, 'MeetingsPage');
const MeetingDetailPage = lazyRouteComponent(meetingsModule, 'MeetingDetailPage');
const TasksPage = lazyRouteComponent(() => import('@/features/tasks/tasks-page'), 'TasksPage');
const DashboardPage = lazyRouteComponent(() => import('@/pages/app-pages'), 'DashboardPage');
const ProjectsPage = lazyRouteComponent(
  () => import('@/features/projects/projects-page'),
  'ProjectsPage',
);
const SettingsPage = lazyRouteComponent(
  () => import('@/features/settings/settings-page'),
  'SettingsPage',
);
const TeamMembersPage = lazyRouteComponent(
  () => import('@/features/teams/team-members-page'),
  'TeamMembersPage',
);
const CreateOrganizationPage = lazyRouteComponent(
  () => import('@/features/organizations/create-organization'),
  'CreateOrganizationPage',
);
const ExtensionPairPage = lazyRouteComponent(
  () => import('@/features/extension/pair-page'),
  'ExtensionPairPage',
);

export type RouterContext = { queryClient: QueryClient; api: ApiClient };

/**
 * Route error boundary: auth/availability failures (401, 5xx incl. dev-proxy HTML
 * 502/504, network errors) send the user to /login?next=; anything else shows the
 * standard error state instead of the router's default "Something went wrong!".
 */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  const redirectToLogin = isAuthOrUnavailable(error) && router.state.location.pathname !== '/login';
  useEffect(() => {
    if (!redirectToLogin) return;
    void router.navigate({
      to: '/login',
      search: { next: safeRedirect(router.state.location.href, '/') },
      replace: true,
    });
  }, [redirectToLogin, router]);
  if (redirectToLogin) return null;
  return (
    <div className="p-6">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: RouteError,
  notFoundComponent: () => <EmptyState title="Page not found" />,
});

/** `?next=` carries the post-login destination; always passed through safeRedirect. */
type NextSearch = { next?: string };
const validateNext = (search: Record<string, unknown>): NextSearch =>
  typeof search.next === 'string' ? { next: search.next } : {};

// ---- Auth (public) ----
const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  component: () => (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  ),
});

function useCompleteSignIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async (session: AuthSession, next: string | undefined) => {
    // Seed the session cache from the login/signup response (minus the CSRF token,
    // which only the API client keeps) so the guard sees the fresh session and does
    // not bounce back to /login with a cached `null` from the earlier redirect.
    const { csrfToken: _csrf, ...fresh } = session;
    void _csrf;
    queryClient.setQueryData<GetAuthSessionResponse | null>(queryKeys.session, fresh);
    applySessionToStore(fresh);
    await router.invalidate();
    await router.navigate({ href: safeRedirect(next, '/') });
  };
}

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/login',
  validateSearch: validateNext,
  component: function LoginPage() {
    const api = useApi();
    const { next } = loginRoute.useSearch();
    const complete = useCompleteSignIn();
    return <LoginForm onSubmit={async (v) => complete(await api.auth.login(v), next)} />;
  },
});

const signupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/signup',
  validateSearch: validateNext,
  component: function SignupPage() {
    const api = useApi();
    const { next } = signupRoute.useSearch();
    return (
      <SignupForm
        next={next}
        onSubmit={async ({ name, email, password }) => {
          await api.auth.signup({ name, email, password });
        }}
        onResend={(email) => api.auth.resendVerification({ email })}
      />
    );
  },
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/forgot-password',
  component: function ForgotPasswordPage() {
    const api = useApi();
    return <ForgotPasswordForm onSubmit={(v) => api.auth.forgotPassword(v)} />;
  },
});

// ---- App (guarded) ----
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    let session: Awaited<ReturnType<typeof ensureSession>> = null;
    try {
      session = await ensureSession(context.queryClient, context.api);
    } catch {
      // Unexpected session failure: treat as signed out rather than crashing.
      session = null;
    }
    if (!session) {
      // TanStack Router control flow: redirect() returns a Redirect object to throw.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/login', search: { next: safeRedirect(location.href, '/') } });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/',
  component: DashboardPage,
});
const meetingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/meetings',
  component: MeetingsPage,
});
const meetingDetailRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/meetings/$meetingId',
  component: function MeetingDetailRoute() {
    const { meetingId } = meetingDetailRoute.useParams();
    return <MeetingDetailPage meetingId={meetingId} />;
  },
});
const tasksRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/tasks',
  validateSearch: parseTaskSearch,
  component: function TasksRoute() {
    const search = tasksRoute.useSearch();
    const navigate = tasksRoute.useNavigate();
    const { data: session } = useSession();
    return (
      <TasksPage
        search={search}
        {...(session ? { currentUserId: session.user.id } : {})}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
const projectsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/projects',
  component: ProjectsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/settings',
  validateSearch: parseSettingsSearch,
  component: function SettingsRoute() {
    return <SettingsPage tab={settingsRoute.useSearch().tab} />;
  },
});
const teamMembersRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/settings/teams/$teamId',
  component: function TeamMembersRoute() {
    const { teamId } = teamMembersRoute.useParams();
    return <TeamMembersPage key={teamId} teamId={teamId} />;
  },
});

const createOrganizationRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/organizations/new',
  component: CreateOrganizationPage,
});

const extensionPairRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/extension/pair',
  validateSearch: parsePairSearch,
  component: function ExtensionPairRoute() {
    return <ExtensionPairPage search={extensionPairRoute.useSearch()} />;
  },
});

const desktopAuthorizeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/desktop/authorize',
  validateSearch: parseDesktopAuthorizeSearch,
  component: function DesktopAuthorizeRoute() {
    const search = desktopAuthorizeRoute.useSearch();
    return (
      <Suspense fallback={<div className="p-6" aria-busy="true" />}>
        <DesktopAuthorizePage search={search} />
      </Suspense>
    );
  },
});

export const routeTree = rootRoute.addChildren([
  authLayout.addChildren([loginRoute, signupRoute, forgotPasswordRoute]),
  createAuthPublicRoutes(() => rootRoute),
  appLayout.addChildren([
    dashboardRoute,
    meetingsRoute,
    meetingDetailRoute,
    tasksRoute,
    projectsRoute,
    settingsRoute,
    teamMembersRoute,
    createOrganizationRoute,
    extensionPairRoute,
    desktopAuthorizeRoute,
    createAccountRoutes(() => appLayout),
    createOrganizationRoutes(() => appLayout),
    createTaskReviewRoutes(() => appLayout),
  ]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history ? { history } : {}),
    defaultPreload: 'intent',
    defaultErrorComponent: RouteError,
    defaultPendingComponent: RoutePending,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
