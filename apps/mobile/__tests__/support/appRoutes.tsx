import { Slot } from 'expo-router';

import AppLayout from '../../app/(app)/_layout';
import TabsLayout from '../../app/(app)/(tabs)/_layout';
import AccountTab from '../../app/(app)/(tabs)/account';
import MeetingsTab from '../../app/(app)/(tabs)/index';
import RecordTab from '../../app/(app)/(tabs)/record';
import TasksTab from '../../app/(app)/(tabs)/tasks';
import Organizations from '../../app/(app)/organizations';
import AuthLayout from '../../app/(auth)/_layout';
import Login from '../../app/(auth)/login';
import { AuthProvider } from '../../src/auth/AuthProvider';
import { createMockAuthClient, demoAccount } from '../../src/auth/mockAuthClient';
import { createSessionManager, type SessionManager } from '../../src/auth/sessionManager';
import { createInMemoryTokenStore } from '../../src/auth/tokenStore';
import { createPlaceholderMeetingsRepository } from '../../src/data/meetingsRepository';
import { RepositoriesProvider, type Repositories } from '../../src/data/RepositoriesProvider';
import { createPlaceholderTasksRepository } from '../../src/data/tasksRepository';
import { createPlaceholderUploadQueue } from '../../src/data/uploadQueue';

export const account = demoAccount('ada@example.com', 'correct horse battery');

export function makeRepositories(overrides: Partial<Repositories> = {}): Repositories {
  return {
    meetings: createPlaceholderMeetingsRepository(),
    tasks: createPlaceholderTasksRepository(),
    uploadQueue: createPlaceholderUploadQueue(),
    ...overrides,
  };
}

/** Same file tree as `app/`, with injectable session manager and repositories. */
export function routes(manager: SessionManager, repositories: Repositories = makeRepositories()) {
  return {
    _layout: () => (
      <AuthProvider manager={manager}>
        <RepositoriesProvider value={repositories}>
          <Slot />
        </RepositoriesProvider>
      </AuthProvider>
    ),
    '(auth)/_layout': AuthLayout,
    '(auth)/login': Login,
    '(app)/_layout': AppLayout,
    '(app)/(tabs)/_layout': TabsLayout,
    '(app)/(tabs)/index': MeetingsTab,
    '(app)/(tabs)/record': RecordTab,
    '(app)/(tabs)/tasks': TasksTab,
    '(app)/(tabs)/account': AccountTab,
    '(app)/organizations': Organizations,
  };
}

export function makeManager() {
  const client = createMockAuthClient({ accounts: [account] });
  const store = createInMemoryTokenStore();
  return { client, store, manager: createSessionManager({ client, store }) };
}
