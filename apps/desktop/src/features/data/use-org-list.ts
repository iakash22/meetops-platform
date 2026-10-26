import { useCallback, useEffect, useState } from 'react';

import { AuthError } from '@/features/auth/auth-client';
import { useSession } from '@/features/auth/session';

export type ListState<T> =
  { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error'; message: string };

/** Loads an org-scoped list for the active org; reloads on org change. Errors are user-safe text for a toast. */
export function useOrgList<T>(load: (organizationId: string) => Promise<T[]>) {
  const { session } = useSession();
  const org = session?.activeOrganizationId ?? null;
  const [state, setState] = useState<ListState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!org) {
      setState({ status: 'ready', items: [] });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    load(org).then(
      (items) => live && setState({ status: 'ready', items }),
      (e: unknown) =>
        live &&
        setState({
          status: 'error',
          message:
            e instanceof AuthError ? e.message : "Couldn't load. Check your connection and retry.",
        }),
    );
    return () => {
      live = false;
    };
  }, [org, load, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { state, retry };
}
