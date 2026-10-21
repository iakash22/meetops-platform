import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  type RouterHistory
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/app-shell';
import { EmptyState } from '@/components/states/states';
import { ForgotPasswordForm, LoginForm, SignupForm } from '@/features/auth/forms';
import { useApi } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { DashboardPage, MeetingsPage, ProjectsPage, SettingsPage, TasksPage } from '@/pages/app-pages';
import { useOrgStore } from '@/stores/org-store';

export type RouterContext = { queryClient: QueryClient; api: ApiClient };

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => <EmptyState title="Page not found" />
});

// ---- Auth (public) ----
const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  component: () => (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4" data-testid="auth-layout">
      <Outlet />
    </div>
  )
});

function LoginPage() {
  const api = useApi();
  const navigate = useNavigate();
  const setOrganizations = useOrgStore((s) => s.setOrganizations);
  return (
    <LoginForm
      onSubmit={async (v) => {
        const session = await api.auth.login(v);
        setOrganizations(session.organizations);
        await navigate({ to: '/' });
      }}
    />
  );
}

function SignupPage() {
  const api = useApi();
  const navigate = useNavigate();
  const setOrganizations = useOrgStore((s) => s.setOrganizations);
  return (
    <SignupForm
      onSubmit={async ({ name, email, password }) => {
        const session = await api.auth.signup({ name, email, password });
        setOrganizations(session.organizations);
        await navigate({ to: '/' });
      }}
    />
  );
}

function ForgotPasswordPage() {
  const api = useApi();
  return (
    <ForgotPasswordForm
      onSubmit={async (v) => {
        await api.auth.forgotPassword(v);
      }}
    />
  );
}

const loginRoute = createRoute({ getParentRoute: () => authLayout, path: '/login', component: LoginPage });
const signupRoute = createRoute({ getParentRoute: () => authLayout, path: '/signup', component: SignupPage });
const forgotPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/forgot-password',
  component: ForgotPasswordPage
});

// ---- App (shell) ----
// TODO(auth): add beforeLoad guard redirecting to /login once the session contract exists.
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  )
});

const dashboardRoute = createRoute({ getParentRoute: () => appLayout, path: '/', component: DashboardPage });
const meetingsRoute = createRoute({ getParentRoute: () => appLayout, path: '/meetings', component: MeetingsPage });
const tasksRoute = createRoute({ getParentRoute: () => appLayout, path: '/tasks', component: TasksPage });
const projectsRoute = createRoute({ getParentRoute: () => appLayout, path: '/projects', component: ProjectsPage });
const settingsRoute = createRoute({ getParentRoute: () => appLayout, path: '/settings', component: SettingsPage });

export const routeTree = rootRoute.addChildren([
  authLayout.addChildren([loginRoute, signupRoute, forgotPasswordRoute]),
  appLayout.addChildren([dashboardRoute, meetingsRoute, tasksRoute, projectsRoute, settingsRoute])
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
