import type {
  ApprovalDecisionValue,
  ExtractedTask,
  ExtractedTaskReviewStatus,
  Task,
  TaskPriority,
  TaskStatus,
} from '@meetops/contracts';
import type { Page } from '../directory/ports.js';

export type TaskFilter = {
  cursor?: string | undefined;
  limit: number;
  status?: TaskStatus[] | undefined;
  priority?: TaskPriority | undefined;
  projectId?: string | undefined;
  meetingId?: string | undefined;
  assigneeId?: string | undefined;
  unassigned?: boolean | undefined;
  dueBefore?: Date | undefined;
  dueAfter?: Date | undefined;
  q?: string | undefined;
};

export type AcceptInput = {
  extractedTaskId: string;
  reviewerId: string;
  title: string;
  priority: TaskPriority;
  description?: string | undefined;
  dueAt?: Date | undefined;
};

export type CreateTaskInput = {
  createdById: string;
  title: string;
  description?: string | undefined;
  status: TaskStatus;
  priority: TaskPriority;
  /** Employee id in the same org. */
  assigneeId?: string | undefined;
  projectId?: string | undefined;
  meetingId?: string | undefined;
  dueAt?: Date | undefined;
};

export type TaskPatch = {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  /** Employee id in the same org; null unassigns. */
  assigneeId?: string | null | undefined;
  dueAt?: Date | null | undefined;
};

/** Aggregates over rows with createdAt in [from, to); soft-deleted rows excluded; lists alphabetical, non-zero. */
export type TaskAnalyticsResult = {
  tasks: { total: number; byStatus: { status: TaskStatus; count: number }[] };
  extractedTasks: {
    total: number;
    byStatus: { status: ExtractedTaskReviewStatus; count: number }[];
  };
  approvals: { total: number; byDecision: { decision: ApprovalDecisionValue; count: number }[] };
};

/** Thrown by repositories; mapped to 404 / 409 by the service. */
export class TaskMissing extends Error {}
/** assigneeId is not an employee of this org (other-org ids look the same as unknown ones). */
export class TaskAssigneeInvalid extends Error {}
/** projectId / meetingId is not a live row of this org (other-org ids look the same as unknown ones). */
export class TaskReferenceInvalid extends Error {
  constructor(readonly field: 'projectId' | 'meetingId') {
    super(field);
  }
}
export class ExtractedTaskMissing extends Error {}
export class ExtractedTaskAlreadyReviewed extends Error {}

/**
 * Task + review persistence. Every method is scoped by the session's organizationId; another org's rows are
 * indistinguishable from missing ones. Accept/dismiss are atomic and only act on `pending_review` rows, so a
 * concurrent second review loses with ExtractedTaskAlreadyReviewed.
 */
export interface TaskRepositories {
  listTasks(organizationId: string, f: TaskFilter): Promise<Page<Task>>;
  /** Pending-review extracted tasks, oldest first. */
  listPendingExtracted(
    organizationId: string,
    q: { meetingId?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<Page<ExtractedTask>>;
  /** Throws TaskMissing for unknown/other-org ids. */
  getTask(organizationId: string, taskId: string): Promise<Task>;
  /** Manual task (not from review). Throws TaskAssigneeInvalid or TaskReferenceInvalid. */
  createTask(organizationId: string, input: CreateTaskInput): Promise<Task>;
  /** Throws TaskMissing or TaskAssigneeInvalid. Absent keys are left unchanged. */
  updateTask(organizationId: string, taskId: string, patch: TaskPatch): Promise<Task>;
  accept(organizationId: string, input: AcceptInput): Promise<Task>;
  dismiss(
    organizationId: string,
    input: { extractedTaskId: string; reviewerId: string },
  ): Promise<void>;
  /** Read-only, aggregate-only counts for the org (P7 analytics). */
  analytics(organizationId: string, q: { from: Date; to: Date }): Promise<TaskAnalyticsResult>;
}
