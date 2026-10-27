import type { Integration } from '@meetops/contracts';

/**
 * Non-secret slice of integration_connections the routes need. Never carries tokens, the webhook secret, the key
 * id or ciphertext (ADR-008). connect/callback/webhook/issue-push need @meetops/integrations (held lockfile step).
 */
export interface IntegrationsRepository {
  list(organizationId: string): Promise<Integration[]>;
  /** Soft revoke that wipes every secret. Idempotent; null when the id is not in this org. */
  disconnect(organizationId: string, integrationId: string): Promise<Integration | null>;
}
