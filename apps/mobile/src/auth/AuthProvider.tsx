import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { AuthState, SessionManager } from './sessionManager';
import type { LoginCredentials } from './types';

const AuthContext = createContext<SessionManager | null>(null);

export function AuthProvider({
  manager,
  children,
}: {
  manager: SessionManager;
  children: ReactNode;
}) {
  useEffect(() => {
    if (manager.getState().status === 'loading') void manager.restore();
  }, [manager]);
  return <AuthContext.Provider value={manager}>{children}</AuthContext.Provider>;
}

export interface UseAuth {
  state: AuthState;
  signIn: (credentials: LoginCredentials) => Promise<void>;
  signOut: () => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<void>;
}

export function useAuth(): UseAuth {
  const manager = useContext(AuthContext);
  if (!manager) throw new Error('useAuth must be used inside <AuthProvider>.');
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);
  return useMemo(
    () => ({
      state,
      signIn: (c) => manager.signIn(c),
      signOut: () => manager.signOut(),
      switchOrganization: (id) => manager.switchOrganization(id),
    }),
    [manager, state],
  );
}
