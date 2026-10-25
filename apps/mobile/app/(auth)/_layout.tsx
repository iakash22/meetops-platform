import { Redirect, Stack } from 'expo-router';

import { useAuth } from '../../src/auth/AuthProvider';
import { guardRedirect } from '../../src/auth/guards';
import { Splash } from '../../src/screens/Splash';
import { stackScreenOptions } from '../../src/ui/navigation';

/** Guard: signed-in users never see the sign-in screens. */
export default function AuthLayout() {
  const { state } = useAuth();
  if (state.status === 'loading') return <Splash />;
  const to = guardRedirect(state.status, 'auth');
  if (to) return <Redirect href={to} />;
  return <Stack screenOptions={{ ...stackScreenOptions, headerShown: false }} />;
}
