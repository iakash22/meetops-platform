import { DomainError } from '../../shared/domain-error.js';

export class PushDeviceNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Push device not found', 404);
  }
}
/** Endpoint not allowlisted / bad Expo token. Never echoes the submitted value. */
export class PushTargetInvalidError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Push target is not allowed', 400);
  }
}
export class InvalidCursorError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Invalid cursor', 400);
  }
}
/** No push token cipher / email link secret on this deployment. */
export class NotificationsUnavailableError extends DomainError {
  constructor(what: string) {
    super('PROVIDER_UNAVAILABLE', `${what} is not configured`, 503);
  }
}
export class UnsubscribeLinkInvalidError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Invalid or expired link', 400);
  }
}
