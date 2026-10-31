import { Redirect, Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '../../src/auth/AuthProvider';
import { takeReturn } from '../../src/auth/deepLink';
import { guardRedirect } from '../../src/auth/guards';
import { RecordingBanner } from '../../src/record/RecordingBanner';
import { Splash } from '../../src/screens/Splash';
import { stackScreenOptions } from '../../src/ui/navigation';

/**
 * Guard: every screen in this group needs a session. Logout or a revoked session lands on /login.
 * Holds the bottom tabs plus the organization switcher modal on top of them.
 */
export default function AppLayout() {
  const { state } = useAuth();
  const router = useRouter();
  const signedIn = state.status === 'signedIn';
  // Second hop of a deep link replayed after sign-in (see deepLink.ts). Only allowlisted screens.
  useEffect(() => {
    if (!signedIn) return;
    const target = takeReturn();
    if (target) router.replace(target);
  }, [signedIn, router]);
  if (state.status === 'loading') return <Splash />;
  const to = guardRedirect(state.status, 'app');
  if (to) return <Redirect href={to} />;
  return (
    <>
      <RecordingBanner />
      <Stack screenOptions={stackScreenOptions}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="meeting/[id]" options={{ title: 'Meeting' }} />
        <Stack.Screen
          name="organizations"
          options={{ title: 'Switch organization', presentation: 'modal' }}
        />
      </Stack>
    </>
  );
}
