import { useCallback, useEffect, useState } from 'react';

export type ListState<T> =
  { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error' };

/**
 * Loads an organization-scoped list and reloads when the active organization changes.
 * Results for a previous organization are dropped, so data never leaks across an org switch.
 */
export function useOrgScopedList<T>(
  organizationId: string | null,
  load: (organizationId: string) => Promise<T[]>,
): { state: ListState<T>; reload: () => void } {
  const [state, setState] = useState<ListState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    setState({ status: 'loading' });
    load(organizationId)
      .then((items) => {
        if (active) setState({ status: 'ready', items });
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [organizationId, load, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
