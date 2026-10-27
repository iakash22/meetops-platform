import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { TaskPriority, TaskStatus } from '../domain/task.js';
export { TASK_PATHS } from '../constants.js';
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

/** v0.8.0: path params of the single-task routes (`TASK_PATHS.task`). */
export const TaskParams = Type.Object(
  { organizationId: Id, taskId: Id },
  { additionalProperties: false },
);
export type TaskParams = Static<typeof TaskParams>;

/**
 * v0.8.0: body of PATCH /orgs/:organizationId/tasks/:taskId (`TASK_PATHS.task`), returning `Task`. A partial update:
 * omitted keys are left unchanged, and `null` clears the optional `description`, `assigneeId` and `dueAt`. At least
 * one key is required and unknown keys are rejected. Matches the API's UpdateTaskBody (feat/task-approval-api).
 *
 * `Null` comes first in each union so Ajv `coerceTypes` cannot turn `null` into `''` on the string branch.
 */
export const UpdateTaskRequest = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    description: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 10_000 })])),
    status: Type.Optional(TaskStatus),
    priority: Type.Optional(TaskPriority),
    assigneeId: Type.Optional(Type.Union([Type.Null(), Id])),
    dueAt: Type.Optional(Type.Union([Type.Null(), IsoDateTime])),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateTaskRequest = Static<typeof UpdateTaskRequest>;

/**
 * v0.10.0: body of POST /orgs/:organizationId/tasks (`TASK_PATHS.tasks`), returning 201 `Task`. A manual task:
 * `status` defaults to `todo` and `priority` to `medium` server-side. `assigneeId` is an employee id; `projectId` and
 * `meetingId` must be live rows of the same organization (400 otherwise). Unknown keys are rejected.
 */
export const CreateTaskRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.Optional(Type.String({ maxLength: 10_000 })),
    status: Type.Optional(TaskStatus),
    priority: Type.Optional(TaskPriority),
    assigneeId: Type.Optional(Id),
    projectId: Type.Optional(Id),
    meetingId: Type.Optional(Id),
    dueAt: Type.Optional(IsoDateTime),
  },
  { additionalProperties: false },
);
export type CreateTaskRequest = Static<typeof CreateTaskRequest>;

/**
 * v0.10.0: body of POST /orgs/:organizationId/extracted-tasks/:extractedTaskId/accept (`TASK_PATHS.accept`), returning
 * 201 `Task`. The reviewer's (possibly edited) values; LLM hints are never copied server-side. Unknown keys rejected.
 */
export const AcceptExtractedTaskRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    priority: TaskPriority,
    description: Type.Optional(Type.String({ maxLength: 10_000 })),
    dueAt: Type.Optional(IsoDateTime),
  },
  { additionalProperties: false },
);
export type AcceptExtractedTaskRequest = Static<typeof AcceptExtractedTaskRequest>;
