import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

export const TaskStatus = Type.Union([
  Type.Literal('todo'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
  Type.Literal('cancelled'),
]);
export type TaskStatus = Static<typeof TaskStatus>;
/** All task statuses, in display order. */
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const satisfies readonly TaskStatus[];
/** Alias of `TaskStatus` for FE (equivalent to `Task['status']`). */
export type TaskStatusValue = TaskStatus;

export const TaskPriority = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);
export type TaskPriority = Static<typeof TaskPriority>;

export const Task = Type.Object({
  id: Id,
  organizationId: Id,
  projectId: Type.Optional(Id),
  meetingId: Type.Optional(Id),
  /** Set when the task was accepted from an ExtractedTask (link direction follows the DB). */
  extractedTaskId: Type.Optional(Id),
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
  /** TranscriptSegment ids the task was extracted from. */
  sourceSegmentIds: Type.Array(Id),
  createdAt: IsoDateTime,
});
export type ExtractedTask = Static<typeof ExtractedTask>;

export const INTEGRATION_PROVIDERS = ['github', 'jira'] as const;
export const IntegrationProvider = Type.Union([Type.Literal('github'), Type.Literal('jira')]);
export type IntegrationProvider = Static<typeof IntegrationProvider>;

export const IssueStatus = Type.Union([
  Type.Literal('open'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
  Type.Literal('closed'),
]);
export type IssueStatus = Static<typeof IssueStatus>;

/**
 * A task's link to an external issue (persisted record).
 *
 * Tenant-scoped: always look up by (organizationId, provider, externalId), which is unique
 * (DB: @@unique([organizationId, provider, externalId])). Cross-tenant lookups must return NOT_FOUND.
 */
export const IntegrationIssue = Type.Object(
  {
    id: Id,
    organizationId: Id,
    /** The specific connected integration instance. */
    integrationId: Id,
    taskId: Id,
    provider: IntegrationProvider,
    /** 'owner/repo#N' (GitHub) or 'PROJ-1' (Jira). */
    externalId: Type.String({ minLength: 1, maxLength: 255 }),
    externalUrl: Type.Optional(Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 })),
    /** Last status seen at sync time, for conflict checks. */
    lastKnownStatus: Type.Optional(IssueStatus),
    syncedAt: Type.Optional(IsoDateTime),
    createdAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type IntegrationIssue = Static<typeof IntegrationIssue>;
/** Alias used by packages/integrations. */
export const IntegrationIssueRecord = IntegrationIssue;
export type IntegrationIssueRecord = IntegrationIssue;
