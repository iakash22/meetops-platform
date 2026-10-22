import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/app-shell';
import { EmptyState } from '@/components/states/states';
import { ForgotPasswordForm, LoginForm, SignupForm } from '@/features/auth/forms';
import { MeetingDetailPage, MeetingsPage } from '@/features/meetings/meetings-pages';
import { applySessionToStore, ensureSession, useSession } from '@/features/session/use-session';
import { parseTaskSearch, TasksPage } from '@/features/tasks/tasks-page';
import { useApi } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/queries';
import { safeRedirect } from '@/lib/safe-redirect';
import { DashboardPage, ProjectsPage, SettingsPage } from '@/pages/app-pages';

export type RouterContext = { queryClient: QueryClient; api: ApiClient };

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
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
    <div
      className="flex min-h-screen items-center justify-center bg-muted/40 p-4"
      data-testid="auth-layout"
    >
      <Outlet />
    </div>
  ),
});

function useCompleteSignIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async (session: Parameters<typeof applySessionToStore>[0], next: string | undefined) => {
    applySessionToStore(session);
    await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    router.history.push(safeRedirect(next, '/'));
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
    const complete = useCompleteSignIn();
    return (
      <SignupForm
        onSubmit={async ({ name, email, password }) =>
          complete(await api.auth.signup({ name, email, password }), next)
        }
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
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  authLayout.addChildren([loginRoute, signupRoute, forgotPasswordRoute]),
  appLayout.addChildren([
    dashboardRoute,
    meetingsRoute,
    meetingDetailRoute,
    tasksRoute,
    projectsRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history ? { history } : {}),
    defaultPreload: 'intent',
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
