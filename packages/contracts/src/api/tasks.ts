import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { TaskPriority, TaskStatus } from '../domain/task.js';
import { CursorPageQuery, MAX_PAGE_LIMIT } from './pagination.js';

const ListTasksQueryBase = {
  cursor: CursorPageQuery.properties.cursor,
  // No `default` (see ListTasksQuery): Ajv strict mode rejects defaults inside anyOf.
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  status: Type.Optional(
    Type.Union([
      TaskStatus,
      Type.Array(TaskStatus, { minItems: 1, maxItems: 4, uniqueItems: true }),
    ]),
  ),
  priority: Type.Optional(TaskPriority),
  projectId: Type.Optional(Id),
  meetingId: Type.Optional(Id),
  dueBefore: Type.Optional(IsoDateTime),
  dueAfter: Type.Optional(IsoDateTime),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
};

/**
 * Query for GET /orgs/:organizationId/tasks, returning `Paginated<Task>`. Filters combine with AND, and an array
 * `status` matches any of the given values. Unknown query params are rejected.
 *
 * `unassigned: true` (literal `true` only) matches tasks with no assignee. It is mutually exclusive with `assigneeId`:
 * the schema is a strict union of a variant that allows `assigneeId` and one that allows `unassigned`, so a query
 * carrying both is rejected.
 *
 * 0.6.1: `limit` carries no `default` here. Fastify's Ajv strict mode refuses to compile a `default` inside `anyOf`,
 * so servers apply DEFAULT_PAGE_LIMIT themselves when `limit` is absent.
 */
export const ListTasksQuery = Type.Union([
  Type.Object(
    { ...ListTasksQueryBase, assigneeId: Type.Optional(Id) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ListTasksQueryBase, unassigned: Type.Optional(Type.Literal(true)) },
    { additionalProperties: false },
  ),
]);
export type ListTasksQuery = Static<typeof ListTasksQuery>;
