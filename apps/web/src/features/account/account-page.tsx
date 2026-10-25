import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorState, LoadingState } from '@/components/states/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { displayName, useSession } from '@/features/session/use-session';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { describeError } from '@/lib/api/error-messages';
import { PageHeader } from '@/pages/resource-list';
import { useOrgStore } from '@/stores/org-store';
import { formatDate } from './device-label';
import { useEndLocalSession } from './end-session';
import { SessionsCard } from './sessions-card';

/**
 * /account: profile basics (read-only; the API has no profile update route yet),
 * active sessions with revoke, and "log out everywhere". Paired extension devices
 * are not listed: the API exposes no device list/revoke route for the web session.
 */
export function AccountPage() {
  return (
    <>
      <PageHeader title="Account" description="Your profile and where you're signed in" />
      <div className="grid max-w-3xl gap-6">
        <ProfileCard />
        <SessionsCard />
        <LogOutEverywhereCard />
      </div>
    </>
  );
}

function ProfileCard() {
  const { data: session, isPending, isError, error, refetch } = useSession();
  const organizations = useOrgStore((s) => s.organizations);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Profile</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isPending || !session ? (
          <LoadingState rows={1} />
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]" data-testid="profile">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{displayName(session.user)}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{session.user.email}</dd>
            <dt className="text-muted-foreground">Member since</dt>
            <dd>
              <time dateTime={session.user.createdAt}>{formatDate(session.user.createdAt)}</time>
            </dd>
            <dt className="text-muted-foreground">Organizations</dt>
            <dd>
              {organizations.length === 0 ? (
                <Link to="/organizations/new" className="underline underline-offset-4">
                  Create an organization
                </Link>
              ) : (
                <ul className="grid gap-1">
                  {organizations.map((o) => (
                    <li key={o.id} className="flex items-center gap-2">
                      {o.name}
                      {o.id === session.activeOrganizationId && session.role ? (
                        <Badge variant="outline">{session.role}</Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function LogOutEverywhereCard() {
  const api = useApi();
  const endLocalSession = useEndLocalSession();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const logOutEverywhere = async () => {
    setPending(true);
    setError(null);
    try {
      await api.auth.logoutAll();
    } catch (err) {
      // 401: every session is already gone, which is the goal.
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err);
        setPending(false);
        return;
      }
    }
    await endLocalSession();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Log out everywhere</h2>
        </CardTitle>
        <CardDescription>
          End every session for this account, including this one, on all devices.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void logOutEverywhere()}
            >
              {pending ? 'Logging out…' : 'Yes, log out all devices'}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Log out all devices
          </Button>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {describeError(error).message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
