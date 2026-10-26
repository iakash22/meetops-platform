import { createContext, useContext, type ReactNode } from 'react';
import type { CursorPage, Meeting, Task } from '@meetops/contracts';

import { invokeTokenFree, type Invoke } from '@/lib/native-auth';
import { SAMPLE_MEETINGS } from '@/features/meetings/sample-meetings';
import { SAMPLE_TASKS } from '@/features/tasks/sample-tasks';

export interface DataSource {
  /** True when rows are typed sample data, not the API. */
  sample: boolean;
  listMeetings: (organizationId: string) => Promise<Meeting[]>;
  listTasks: (organizationId: string) => Promise<Task[]>;
}

const PAGE = 50;
const seg = encodeURIComponent;

/**
 * `api_request` runs in Rust (ADR-012 Decision 3.3): it attaches the desktop bearer, allows only the API origin and
 * the `desktop` scopes, and returns the JSON body. BACKEND DEPENDENCIES: desktop bearer audience; there is no
 * meetings list contract yet (`GET /orgs/:id/meetings` is assumed to return `CursorPage<Meeting>`). Tasks follow
 * `ListTasksQuery` (`GET /orgs/:id/tasks`), but `tasks:read` is not a `desktop` scope in ADR-012 yet.
 */
export function createDataSource(invoke: Invoke | null): DataSource {
  if (!invoke) {
    return {
      sample: true,
      listMeetings: async (org) => SAMPLE_MEETINGS.filter((m) => m.organizationId === org),
      listTasks: async (org) => SAMPLE_TASKS.filter((t) => t.organizationId === org),
    };
  }
  const get = async <T,>(path: string) =>
    (await invokeTokenFree<CursorPage<T>>(invoke, 'api_request', { method: 'GET', path })).items;
  return {
    sample: false,
    // Server scopes by org; the client filter is defence in depth (ADR-004).
    listMeetings: async (org) =>
      (await get<Meeting>(`/orgs/${seg(org)}/meetings?limit=${PAGE}`)).filter(
        (m) => m.organizationId === org,
      ),
    listTasks: async (org) =>
      (await get<Task>(`/orgs/${seg(org)}/tasks?limit=${PAGE}`)).filter(
        (t) => t.organizationId === org,
      ),
  };
}

const DataContext = createContext<DataSource>(createDataSource(null));

export function DataProvider({ value, children }: { value: DataSource; children: ReactNode }) {
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export const useDataSource = () => useContext(DataContext);
