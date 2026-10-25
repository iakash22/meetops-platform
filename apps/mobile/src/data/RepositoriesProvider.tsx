import { createContext, useContext, type ReactNode } from 'react';

import type { MeetingsRepository } from './meetingsRepository';
import type { TasksRepository } from './tasksRepository';
import type { UploadQueue } from './uploadQueue';

export interface Repositories {
  meetings: MeetingsRepository;
  tasks: TasksRepository;
  uploadQueue: UploadQueue;
}

const RepositoriesContext = createContext<Repositories | null>(null);

/** Data sources for screens. The app passes the placeholders from `src/services.ts`; tests pass fakes. */
export function RepositoriesProvider({
  value,
  children,
}: {
  value: Repositories;
  children: ReactNode;
}) {
  return <RepositoriesContext.Provider value={value}>{children}</RepositoriesContext.Provider>;
}

export function useRepositories(): Repositories {
  const value = useContext(RepositoriesContext);
  if (!value) throw new Error('useRepositories must be used inside <RepositoriesProvider>.');
  return value;
}
