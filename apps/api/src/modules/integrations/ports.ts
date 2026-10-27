import type { Integration, IntegrationIssue, TaskStatus } from '@meetops/contracts';

export type ConnectedProvider = 'github' | 'jira';

export interface ConnectionUpsert {
  provider: ConnectedProvider;
  displayName: string;
  externalAccountId: string;
  connectedById: string;
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
  accessTokenExpiresAt: Date | null;
}

/** Decrypted secrets. Never returned over HTTP, logged, or put in audit metadata. */
export interface ConnectionSecrets {
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
}

export type ConnectionView = Integration & { accessTokenExpiresAt: Date | null };

export interface TaskRef {
  id: string;
  title: string;
  description: string | null;
  extractedTaskId: string | null;
}

export interface ApprovalRef {
  id: string;
  extractedTaskId: string;
  reviewerId: string | null;
  decision: 'approved' | 'rejected' | 'changes_requested';
}

/**
 * Org-scoped (RLS) persistence for Phase 5 (ADR-008). Every method except `resolveOrganization` runs inside the
 * organization's RLS context; `resolveOrganization` goes through the SECURITY DEFINER routing function and
 * returns only the org id of a live connection, so webhooks can enter the right RLS scope.
 */
export interface IntegrationsRepository {
  list(organizationId: string): Promise<Integration[]>;
  /** Soft revoke that wipes every secret. Idempotent; null when the id is not in this org. */
  disconnect(organizationId: string, integrationId: string): Promise<Integration | null>;
  /** Connect or reconnect (same provider + external account keeps the id); secrets go through the cipher. */
  upsert(organizationId: string, input: ConnectionUpsert): Promise<Integration>;
  get(organizationId: string, integrationId: string): Promise<ConnectionView | null>;
  readSecrets(organizationId: string, integrationId: string): Promise<ConnectionSecrets | null>;
  setStatus(
    organizationId: string,
    integrationId: string,
    status: 'active' | 'error',
  ): Promise<void>;
  resolveOrganization(provider: ConnectedProvider, integrationId: string): Promise<string | null>;
  getTask(organizationId: string, taskId: string): Promise<TaskRef | null>;
  getApproval(organizationId: string, approvalId: string): Promise<ApprovalRef | null>;
  hasIssueLink(organizationId: string, taskId: string, integrationId: string): Promise<boolean>;
  /** Unique on (org, provider, externalId); a duplicate link is a CONFLICT. */
  createIssueLink(
    organizationId: string,
    link: {
      taskId: string;
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      externalUrl?: string;
    },
  ): Promise<IntegrationIssue>;
  /** Sets the status of every task linked to (integration, externalId); returns how many links matched. */
  applyIssueStatus(
    organizationId: string,
    change: {
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      taskStatus: TaskStatus;
    },
  ): Promise<number>;
}
