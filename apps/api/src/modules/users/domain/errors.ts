import { DomainError } from '../../../shared/domain-error.js';

export class DuplicateEmailError extends DomainError {
  constructor() {
    super('EMAIL_TAKEN', 'An account with this email already exists', 409);
  }
}
