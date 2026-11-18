import { createRoute, lazyRouteComponent, Outlet, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import { AuthLayout } from '@/features/auth/auth-layout';
import {
  applySessionToStore,
  sessionQueryOptions,
  useSession,
} from '@/features/session/use-session';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';
const emailLinkPages = () => import('@/features/auth/email-link-pages');
const AcceptInvitationPage = lazyRouteComponent(emailLinkPages, 'AcceptInvitationPage');
const ResendVerificationForm = lazyRouteComponent(emailLinkPages, 'ResendVerificationForm');
const ResetPasswordForm = lazyRouteComponent(emailLinkPages, 'ResetPasswordForm');
const VerifyEmailPage = lazyRouteComponent(emailLinkPages, 'VerifyEmailPage');
// Type-only: no runtime import cycle with router.tsx (which mounts these routes).
import type { rootRoute as RootRoute } from './router';

/** Tokens in mail links are opaque strings; the API accepts at most 512 characters. */
const MAX_TOKEN_LENGTH = 512;

// Invalid values map to an explicit `undefined`: the router merges the raw (root) search
// into each route's search, so omitting the key would let the unvalidated value through.
type TokenSearch = { token?: string | undefined };
const validateToken = (search: Record<string, unknown>): TokenSearch =>
  typeof search.token === 'string' &&
  search.token.length > 0 &&
  search.token.length <= MAX_TOKEN_LENGTH
    ? { token: search.token }
    : { token: undefined };

type EmailSearch = { email?: string | undefined };
const validateEmail = (search: Record<string, unknown>): EmailSearch =>
  typeof search.email === 'string' && search.email.length <= 254
    ? { email: search.email }
    : { email: undefined };

/**
 * Public routes reached from auth emails (apps/api auth-mail.handler.ts links):
 * /verify-email, /reset-password, /resend-verification and /invitations/accept.
 * None is guarded: verify/reset/resend work signed out, and accept explains how to
 * sign in (keeping the link via ?next=) when there is no session.
 */
export function createAuthPublicRoutes(getRoot: () => typeof RootRoute) {
  const layout = createRoute({
    getParentRoute: getRoot,
    id: 'auth-public',
    component: () => (
      <AuthLayout>
        <Outlet />
      </AuthLayout>
    ),
  });

  const verifyEmailRoute = createRoute({
    getParentRoute: () => layout,
    path: '/verify-email',
    validateSearch: validateToken,
    component: function VerifyEmailRoute() {
      const api = useApi();
      const queryClient = useQueryClient();
      const { token } = verifyEmailRoute.useSearch();
      return (
        <VerifyEmailPage
          token={token}
          onVerify={async (t) => {
            const r = await api.auth.verifyEmail({ token: t });
            // A signed-in session now has emailVerified = true.
            await queryClient.invalidateQueries({ queryKey: queryKeys.session });
            return r;
          }}
        />
      );
    },
  });

  const resetPasswordRoute = createRoute({
    getParentRoute: () => layout,
    path: '/reset-password',
    validateSearch: validateToken,
    component: function ResetPasswordRoute() {
      const api = useApi();
      const queryClient = useQueryClient();
      const { token } = resetPasswordRoute.useSearch();
      return (
        <ResetPasswordForm
          token={token}
          onSubmit={async (body) => {
            await api.auth.resetPassword(body);
            // The API revoked every session (this browser's included) and cleared the cookie.
            queryClient.clear();
            queryClient.setQueryData<GetAuthSessionResponse | null>(queryKeys.session, null);
            useOrgStore.getState().reset();
          }}
        />
      );
    },
  });

  const resendVerificationRoute = createRoute({
    getParentRoute: () => layout,
    path: '/resend-verification',
    validateSearch: validateEmail,
    component: function ResendVerificationRoute() {
      const api = useApi();
      const { email } = resendVerificationRoute.useSearch();
      return (
        <ResendVerificationForm
          defaultEmail={email}
          onSubmit={(v) => api.auth.resendVerification(v)}
        />
      );
    },
  });

  const acceptInvitationRoute = createRoute({
    getParentRoute: () => layout,
    path: '/invitations/accept',
    validateSearch: validateToken,
    component: function AcceptInvitationRoute() {
      const api = useApi();
      const router = useRouter();
      const queryClient = useQueryClient();
      const { token } = acceptInvitationRoute.useSearch();
      const { data: session, isPending } = useSession();
      return (
        <AcceptInvitationPage
          token={token}
          sessionLoading={isPending}
          signedInAs={session ? session.user.email : null}
          onAccept={async (t) => {
            const { organization } = await api.invitations.accept({ token: t });
            // Accepting adds the membership but does not change the active org: switch
            // into it (rotates the session + CSRF) and reload the session from the API.
            await api.organizations.switch({ organizationId: organization.id });
            const fresh = await queryClient.fetchQuery({
              ...sessionQueryOptions(api),
              staleTime: 0,
            });
            if (fresh) applySessionToStore(fresh);
            useOrgStore.getState().setCurrentOrganization(organization.id);
            await queryClient.invalidateQueries({ queryKey: ['orgs'] });
            await router.navigate({ to: '/' });
          }}
        />
      );
    },
  });

  return layout.addChildren([
    verifyEmailRoute,
    resetPasswordRoute,
    resendVerificationRoute,
    acceptInvitationRoute,
  ]);
}
