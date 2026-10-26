import type { CursorPage, Meeting, Task } from '@meetops/contracts';

import { createApiRequester } from '../api/client';
import type { MeetingsRepository } from './meetingsRepository';
import type { TasksRepository } from './tasksRepository';

/**
 * HTTP repositories, org-scoped by path. Both routes return `CursorPage<T>`; the first page is enough for the tabs.
 * - `GET /orgs/:organizationId/tasks`    (contracts `ListTasksQuery`)
 * - `GET /orgs/:organizationId/meetings` BACKEND DEPENDENCY: no list contract yet; assumed to mirror tasks.
 */
export interface HttpRepositoryOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

const PAGE = 'limit=50';

export function createHttpMeetingsRepository(opts: HttpRepositoryOptions): MeetingsRepository {
  const request = createApiRequester(opts);
  return {
    async list(organizationId) {
      const page = await request<CursorPage<Meeting>>(
        'GET',
        `/orgs/${encodeURIComponent(organizationId)}/meetings?${PAGE}`,
      );
      return page.items.filter((m) => m.organizationId === organizationId);
    },
  };
}

export function createHttpTasksRepository(opts: HttpRepositoryOptions): TasksRepository {
  const request = createApiRequester(opts);
  return {
    async list(organizationId) {
      const page = await request<CursorPage<Task>>(
        'GET',
        `/orgs/${encodeURIComponent(organizationId)}/tasks?${PAGE}`,
      );
      return page.items.filter((t) => t.organizationId === organizationId);
    },
  };
}
