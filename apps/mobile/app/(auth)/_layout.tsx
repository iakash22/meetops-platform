import { Redirect, Stack, useGlobalSearchParams } from 'expo-router';

import { useAuth } from '../../src/auth/AuthProvider';
import { rememberReturn } from '../../src/auth/deepLink';
import { guardRedirect } from '../../src/auth/guards';
import { Splash } from '../../src/screens/Splash';
import { stackScreenOptions } from '../../src/ui/navigation';

/** Guard: signed-in users never see the sign-in screens. */
export default function AuthLayout() {
  const { state } = useAuth();
  const { next } = useGlobalSearchParams<{ next?: string }>();
  if (state.status === 'loading') return <Splash />;
  const to = guardRedirect(state.status, 'auth');
  // Only replay a deep link to one of our own screens; anything else goes home.
  if (to) {
    rememberReturn(next);
    return <Redirect href={to} />;
  }
  return <Stack screenOptions={{ ...stackScreenOptions, headerShown: false }} />;
}
