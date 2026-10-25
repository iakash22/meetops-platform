import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LoginRequest, SignupRequest } from '@meetops/contracts';

import type { AuthClient, DesktopSession, SignUpResult } from './auth-client';

interface SessionContextValue {
  session: DesktopSession | null;
  signIn: (request: LoginRequest) => Promise<void>;
  /** Creates the account only. Never sets a session: sign-up returns 202 and the email must be verified. */
  signUp: (request: SignupRequest) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Holds the session in React state only (memory). Nothing is written to localStorage or disk. */
export function SessionProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [session, setSession] = useState<DesktopSession | null>(null);

  const signIn = useCallback(
    async (request: LoginRequest) => {
      setSession(await client.signIn(request));
    },
    [client],
  );
  const signUp = useCallback((request: SignupRequest) => client.signUp(request), [client]);
  const signOut = useCallback(async () => {
    try {
      await client.signOut();
    } finally {
      setSession(null);
    }
  }, [client]);

  const value = useMemo(
    () => ({ session, signIn, signUp, signOut }),
    [session, signIn, signUp, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

export function displayName(session: DesktopSession): string {
  return session.user.name ?? session.user.email;
}

export function activeOrganizationName(session: DesktopSession): string | null {
  return session.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? null;
}
