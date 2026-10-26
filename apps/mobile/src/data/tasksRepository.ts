import type { Task } from '@meetops/contracts';

/**
 * Read side of tasks for the Tasks tab. The API has no list-tasks route yet (contracts define
 * `ListTasksQuery`, Backend has not implemented it), so only a placeholder implementation exists.
 */
export interface TasksRepository {
  /** Tasks of one organization. Never mixes organizations. */
  list: (organizationId: string) => Promise<Task[]>;
}

const T = '2026-10-21T09:00:00.000Z';

function placeholder(
  organizationId: string,
  n: number,
  title: string,
  status: Task['status'],
  priority: Task['priority'],
): Task {
  return {
    id: `00000000-0000-4000-a000-${organizationId.slice(-4)}0000000${n}`,
    organizationId,
    title,
    status,
    priority,
    createdAt: T,
    updatedAt: T,
  };
}

export function createPlaceholderTasksRepository(latencyMs = 0): TasksRepository {
  return {
    async list(organizationId) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return [
        placeholder(organizationId, 1, 'Send recap to the customer', 'todo', 'high'),
        placeholder(organizationId, 2, 'Update the onboarding deck', 'in_progress', 'medium'),
        placeholder(organizationId, 3, 'File the pricing follow-up', 'done', 'low'),
      ];
    },
  };
}
