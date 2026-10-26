import { DomainError } from '../../shared/domain-error.js';

/**
 * 404s for the insights routes. Unknown, deleted and other-org meetings give the same body. A meeting with no merged
 * transcript or no report yet also returns 404 (the web app treats it as "not ready yet"). No contracts NOT_FOUND
 * reason exists for these yet, so `error.reason` is omitted.
 */
export class MeetingNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Meeting not found', 404);
  }
}
export class TranscriptNotReadyError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Transcript not available yet', 404);
  }
}
export class ReportNotReadyError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Report not available yet', 404);
  }
}
