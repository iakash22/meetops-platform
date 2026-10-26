import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LoginRequest, SignupRequest } from '@meetops/contracts';

import type { AuthClient, DesktopSession, SignUpResult } from './auth-client';

interface SessionContextValue {
  session: DesktopSession | null;
  signIn: (request: LoginRequest) => Promise<void>;
  /** Creates the account only. Never sets a session: sign-up returns 202 and the email must be verified. */
  signUp: (request: SignupRequest) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  /** ADR-012 system-browser sign-in; undefined when this client has no browser flow. */
  signInWithBrowser: (() => Promise<void>) | undefined;
  /** True while the stored session is being reloaded on launch. */
  restoring: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Holds the session in React state only (memory). Nothing is written to localStorage or disk. */
export function SessionProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [restoring, setRestoring] = useState(Boolean(client.restore));

  useEffect(() => {
    if (!client.restore) return;
    let live = true;
    client
      .restore()
      .then((s) => live && setSession(s))
      .catch(() => undefined) // Restore failures land on the sign-in screen.
      .finally(() => live && setRestoring(false));
    return () => {
      live = false;
    };
  }, [client]);

  const signIn = useCallback(
    async (request: LoginRequest) => {
      setSession(await client.signIn(request));
    },
    [client],
  );
  const browser = client.signInWithBrowser;
  const signInWithBrowser = useMemo(
    () =>
      browser
        ? async () => {
            setSession(await browser());
          }
        : undefined,
    [browser],
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
    () => ({ session, signIn, signUp, signOut, signInWithBrowser, restoring }),
    [session, signIn, signUp, signOut, signInWithBrowser, restoring],
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
