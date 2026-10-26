import { lazy, Suspense, useMemo, useState } from 'react';

import { AppShell, type View } from '@/components/layout/app-shell';
import type { AuthClient } from '@/features/auth/auth-client';
import { SessionProvider, useSession } from '@/features/auth/session';
import { SignInScreen } from '@/features/auth/sign-in-screen';
import { createUnavailableAuthClient } from '@/features/auth/unavailable-auth';
import { isMockAuthEnabled } from '@/lib/config';

// Only the sign-in screen is in the entry chunk; everything behind it loads on demand.
const SignUpScreen = lazy(() =>
  import('@/features/auth/sign-up-screen').then((m) => ({ default: m.SignUpScreen })),
);
const MeetingsScreen = lazy(() =>
  import('@/features/meetings/meetings-screen').then((m) => ({ default: m.MeetingsScreen })),
);
const SettingsScreen = lazy(() =>
  import('@/features/settings/settings-screen').then((m) => ({ default: m.SettingsScreen })),
);

function Loading() {
  return (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Loading…
    </p>
  );
}

function Screens({ mockAuth }: { mockAuth: boolean }) {
  const { session } = useSession();
  const [view, setView] = useState<View>('meetings');
  const [authView, setAuthView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (!session) {
    return mockAuth && authView === 'sign-up' ? (
      <Suspense fallback={<Loading />}>
        <SignUpScreen onSignIn={() => setAuthView('sign-in')} />
      </Suspense>
    ) : (
      <SignInScreen mockAuth={mockAuth} onCreateAccount={() => setAuthView('sign-up')} />
    );
  }
  return (
    <AppShell view={view} onNavigate={setView}>
      <Suspense fallback={<Loading />}>
        {view === 'meetings' ? <MeetingsScreen /> : <SettingsScreen />}
      </Suspense>
    </AppShell>
  );
}

export function App({ authClient, mockAuth }: { authClient?: AuthClient; mockAuth?: boolean }) {
  const mock = mockAuth ?? isMockAuthEnabled();
  // TODO(desktop-auth): replace with the ADR-012 browser + PKCE client once the ADR is signed off.
  // The mock client is imported lazily so production (mock off) never ships it in the entry chunk.
  const client = useMemo<AuthClient>(() => {
    if (authClient) return authClient;
    if (!mock) return createUnavailableAuthClient();
    let real: AuthClient | null = null;
    const load = async () =>
      (real ??= (await import('@/features/auth/mock-auth')).createMockAuthClient());
    return {
      signIn: async (r) => (await load()).signIn(r),
      signUp: async (r) => (await load()).signUp(r),
      signOut: async () => (await load()).signOut(),
    };
  }, [authClient, mock]);
  return (
    <SessionProvider client={client}>
      <Screens mockAuth={mock} />
    </SessionProvider>
  );
}
