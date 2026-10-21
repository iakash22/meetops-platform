import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { TaskPriority, TaskStatus } from '../domain/task.js';
import { CursorPageQuery } from './pagination.js';

/**
 * Query for GET /orgs/:organizationId/tasks, returning `Paginated<Task>`. Filters combine with AND, and an array
 * `status` matches any of the given values. Unknown query params are rejected.
 */
export const ListTasksQuery = Type.Object(
  {
    ...CursorPageQuery.properties,
    status: Type.Optional(Type.Union([TaskStatus, Type.Array(TaskStatus, { minItems: 1, maxItems: 4, uniqueItems: true })])),
    priority: Type.Optional(TaskPriority),
    assigneeId: Type.Optional(Id),
    projectId: Type.Optional(Id),
    meetingId: Type.Optional(Id),
    dueBefore: Type.Optional(IsoDateTime),
    dueAfter: Type.Optional(IsoDateTime),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ListTasksQuery = Static<typeof ListTasksQuery>;
