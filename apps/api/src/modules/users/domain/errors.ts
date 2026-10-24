import { DomainError } from '../../../shared/domain-error.js';

export class DuplicateEmailError extends DomainError {
  constructor() {
    super('CONFLICT', 'An account with this email already exists', 409, 'EMAIL_TAKEN');
  }
}
