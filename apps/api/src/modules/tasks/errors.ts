import { DomainError } from '../../shared/domain-error.js';

/** Unknown, other-org and deleted extracted tasks give the same body. No contracts NOT_FOUND reason exists yet. */
export class ExtractedTaskNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Extracted task not found', 404);
  }
}
/** The extracted task was already accepted or dismissed (including by a concurrent request). */
export class ExtractedTaskReviewedError extends DomainError {
  constructor() {
    super('CONFLICT', 'Extracted task was already reviewed', 409);
  }
}

export class TaskNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Task not found', 404);
  }
}
export class TaskAssigneeInvalidError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'assigneeId is not an employee of this organization', 400);
  }
}
