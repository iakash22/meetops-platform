import type { ExtractedTask, Task, TaskPriority, TaskStatus } from '@meetops/contracts';
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

/** Thrown by repositories; mapped to 404 / 409 by the service. */
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
  accept(organizationId: string, input: AcceptInput): Promise<Task>;
  dismiss(
    organizationId: string,
    input: { extractedTaskId: string; reviewerId: string },
  ): Promise<void>;
}
