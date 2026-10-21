import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

export const TaskStatus = Type.Union([
  Type.Literal('todo'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
  Type.Literal('cancelled'),
]);
export const TaskPriority = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);

export const Task = Type.Object({
  id: Id,
  organizationId: Id,
  projectId: Type.Optional(Id),
  meetingId: Type.Optional(Id),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.Optional(Type.String()),
  status: TaskStatus,
  priority: TaskPriority,
  assigneeId: Type.Optional(Id),
  dueAt: Type.Optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = Static<typeof Task>;

/** AI-extracted candidate task before a human accepts it into a Task. */
export const ExtractedTask = Type.Object({
  id: Id,
  meetingId: Id,
  reportId: Id,
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  /**
   * UNTRUSTED: free text produced by the LLM from meeting content. Never use it as a user id or for
   * authorization or lookups without human confirmation. Escape it when rendering.
   */
  assigneeHint: Type.Optional(
    Type.String({ maxLength: 200, description: 'UNTRUSTED LLM output; display only, never used for authz or identity' }),
  ),
  dueHint: Type.Optional(Type.String()),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  sourceSegmentIndexes: Type.Array(Type.Integer({ minimum: 0 })),
  acceptedTaskId: Type.Optional(Id),
  createdAt: IsoDateTime,
});
export type ExtractedTask = Static<typeof ExtractedTask>;

export const IntegrationIssue = Type.Object({
  id: Id,
  taskId: Id,
  /** Integration key, e.g. "linear", "jira", "github". */
  integration: Type.String({ minLength: 1 }),
  externalId: Type.String(),
  externalUrl: Type.Optional(Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 })),
  syncedAt: Type.Optional(IsoDateTime),
  createdAt: IsoDateTime,
});
export type IntegrationIssue = Static<typeof IntegrationIssue>;
