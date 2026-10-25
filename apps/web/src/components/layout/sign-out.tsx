import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { describeError } from '@/lib/api/error-messages';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

type Scope = 'this-device' | 'everywhere';

/**
 * Sign-out controls. "Log out" calls POST /auth/logout (this session only);
 * "Log out everywhere" calls POST /auth/logout-all (every session for the user).
 * On success - or a 401, meaning the session is already gone - all cached data is
 * dropped, the org store is reset and the user lands on /login. Any other failure
 * keeps the user signed in and shows the error.
 */
export function SignOutControls() {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const resetOrgs = useOrgStore((s) => s.reset);
  const [pending, setPending] = useState<Scope | null>(null);
  const [error, setError] = useState<unknown>(null);

  const signOut = async (scope: Scope) => {
    setPending(scope);
    setError(null);
    try {
      await (scope === 'everywhere' ? api.auth.logoutAll() : api.auth.logout());
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err);
        setPending(null);
        return;
      }
    }
    await router.navigate({ to: '/login', replace: true });
    queryClient.clear();
    queryClient.setQueryData<GetAuthSessionResponse | null>(queryKeys.session, null);
    resetOrgs();
  };

  return (
    <div className="flex items-center gap-1">
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {describeError(error).message}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        onClick={() => void signOut('this-device')}
      >
        <LogOut className="h-4 w-4" aria-hidden />
        {pending === 'this-device' ? 'Logging out…' : 'Log out'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        title="End every session for this account, on all devices"
        onClick={() => void signOut('everywhere')}
      >
        {pending === 'everywhere' ? 'Logging out…' : 'Log out everywhere'}
      </Button>
    </div>
  );
}
