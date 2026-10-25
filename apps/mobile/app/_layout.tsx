import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from '../src/auth/AuthProvider';
import { SignupApiProvider } from '../src/auth/SignupApiProvider';
import { RepositoriesProvider } from '../src/data/RepositoriesProvider';
import { repositories, sessionManager, signupApi } from '../src/services';
import { stackScreenOptions } from '../src/ui/navigation';

export default function RootLayout() {
  return (
    <AuthProvider manager={sessionManager}>
      <SignupApiProvider value={signupApi}>
        <RepositoriesProvider value={repositories}>
          <StatusBar style="light" />
          <Stack screenOptions={{ ...stackScreenOptions, headerShown: false }} />
        </RepositoriesProvider>
      </SignupApiProvider>
    </AuthProvider>
  );
}
