import { DELIVERY_IN_PROGRESS_RETRY_AFTER_SECONDS } from '@meetops/integrations';
import { DomainError } from '../../shared/domain-error.js';

/** Unknown, malformed and other-org integration ids give the same 404 body. */
export class IntegrationNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Integration not found', 404);
  }
}
export class TaskNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Task not found', 404);
  }
}
/** Revoked/errored connection, or the provider is not configured on this deployment. */
export class IntegrationNotConnectedError extends DomainError {
  constructor(message = 'Integration is not connected') {
    super('CONFLICT', message, 409, 'INTEGRATION_NOT_CONNECTED');
  }
}
/** No integrations runtime (KEK, state store, provider secrets) on this deployment. */
/** The provider app (GitHub App / Jira OAuth app) is not configured on this deployment (#282 L-1). */
export class IntegrationNotConfiguredError extends DomainError {
  constructor(message: string) {
    super('PROVIDER_UNAVAILABLE', message, 503, 'INTEGRATION_NOT_CONFIGURED');
  }
}

export class IntegrationsUnavailableError extends DomainError {
  constructor() {
    super('PROVIDER_UNAVAILABLE', 'Integrations are not configured', 503);
  }
}
/** Upstream provider failed. Never carries the upstream body. */
export class ProviderUpstreamError extends DomainError {
  constructor() {
    super('PROVIDER_UNAVAILABLE', 'The provider request failed', 502);
  }
}
export class OAuthStateInvalidError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Authorization state is invalid or expired', 400, 'OAUTH_STATE_INVALID');
  }
}
export class CallbackRejectedError extends DomainError {
  constructor(message: string) {
    super('BAD_REQUEST', message, 400);
  }
}
export class WebhookSignatureError extends DomainError {
  constructor() {
    super('UNAUTHENTICATED', 'Webhook signature is invalid', 401, 'WEBHOOK_SIGNATURE_INVALID');
  }
}
export class ReplayedDeliveryError extends DomainError {
  constructor() {
    super('CONFLICT', 'Delivery already processed', 409, 'REPLAYED_DELIVERY');
  }
}
/** Another request holds this delivery's pending claim: retryable 409 with Retry-After (not a replay). */
export class DeliveryInProgressError extends DomainError {
  readonly retryAfterMs = DELIVERY_IN_PROGRESS_RETRY_AFTER_SECONDS * 1000;
  constructor() {
    super('CONFLICT', 'Delivery is being processed; retry later', 409, 'DELIVERY_IN_PROGRESS');
  }
}
export class WebhookRejectedError extends DomainError {
  constructor(status: 400 | 413) {
    super(status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', 'Webhook rejected', status);
  }
}
export class ApprovalRequiredHttpError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'An approved task approval is required', 403, 'APPROVAL_REQUIRED');
  }
}
export class IssueAlreadyLinkedError extends DomainError {
  constructor() {
    super('CONFLICT', 'Task is already linked to this integration', 409);
  }
}
export class InvalidTargetError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'Target does not match the integration provider', 400);
  }
}
