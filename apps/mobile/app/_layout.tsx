import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from '../src/auth/AuthProvider';
import { RepositoriesProvider } from '../src/data/RepositoriesProvider';
import { repositories, sessionManager } from '../src/services';
import { stackScreenOptions } from '../src/ui/navigation';

export default function RootLayout() {
  return (
    <AuthProvider manager={sessionManager}>
      <RepositoriesProvider value={repositories}>
        <StatusBar style="light" />
        <Stack screenOptions={{ ...stackScreenOptions, headerShown: false }} />
      </RepositoriesProvider>
    </AuthProvider>
  );
}
