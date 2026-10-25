import { Redirect, Stack } from 'expo-router';

import { useAuth } from '../../src/auth/AuthProvider';
import { guardRedirect } from '../../src/auth/guards';
import { Splash } from '../../src/screens/Splash';
import { stackScreenOptions } from '../../src/ui/navigation';

/** Guard: every screen in this group needs a session. Logout or a revoked session lands on /login. */
export default function AppLayout() {
  const { state } = useAuth();
  if (state.status === 'loading') return <Splash />;
  const to = guardRedirect(state.status, 'app');
  if (to) return <Redirect href={to} />;
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ title: 'Meetings' }} />
      <Stack.Screen
        name="organizations"
        options={{ title: 'Switch organization', presentation: 'modal' }}
      />
    </Stack>
  );
}
