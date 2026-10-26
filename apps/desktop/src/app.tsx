import { useMemo, useState } from 'react';

import { AppShell, type View } from '@/components/layout/app-shell';
import type { AuthClient } from '@/features/auth/auth-client';
import { createMockAuthClient } from '@/features/auth/mock-auth';
import { SessionProvider, useSession } from '@/features/auth/session';
import { SignInScreen } from '@/features/auth/sign-in-screen';
import { SignUpScreen } from '@/features/auth/sign-up-screen';
import { MeetingsScreen } from '@/features/meetings/meetings-screen';
import { SettingsScreen } from '@/features/settings/settings-screen';

function Screens() {
  const { session } = useSession();
  const [view, setView] = useState<View>('meetings');
  const [authView, setAuthView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (!session) {
    return authView === 'sign-up' ? (
      <SignUpScreen onSignIn={() => setAuthView('sign-in')} />
    ) : (
      <SignInScreen onCreateAccount={() => setAuthView('sign-up')} />
    );
  }
  return (
    <AppShell view={view} onNavigate={setView}>
      {view === 'meetings' ? <MeetingsScreen /> : <SettingsScreen />}
    </AppShell>
  );
}

export function App({ authClient }: { authClient?: AuthClient }) {
  // TODO(desktop-auth): swap the mock for the real client once the desktop auth ADR is decided.
  const client = useMemo(() => authClient ?? createMockAuthClient(), [authClient]);
  return (
    <SessionProvider client={client}>
      <Screens />
    </SessionProvider>
  );
}
