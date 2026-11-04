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

/** Tokens an on-demand refresh produced (the webhook secret is re-sealed with them). */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
  accessTokenExpiresAt: Date | null;
}

/**
 * One read for a token refresh: status, expiry, decrypted secrets and an opaque fence (the connection's token
 * generation). Every token write (refresh, reconnect) and every disconnect moves the fence, so a save fenced on it
 * lands only if nothing else wrote since the read. Never log or return it. Null when absent or revoked.
 */
export interface RefreshSnapshot {
  status: Integration['status'];
  accessTokenExpiresAt: Date | null;
  secrets: ConnectionSecrets;
  fence: string;
}

export type SaveRefreshedTokensResult = 'saved' | 'superseded';

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
  /** Token-refresh read (secrets + fence in one read); null when absent or revoked. */
  readForRefresh(organizationId: string, integrationId: string): Promise<RefreshSnapshot | null>;
  /**
   * Fenced save of refreshed tokens: compare-and-swap on `fence` from readForRefresh, and only while the connection
   * is still active. Never changes status, so it cannot reactivate a revoked connection (unlike `upsert`, which is
   * for connect/reconnect only). 'superseded' means another write or a disconnect landed first; nothing was written.
   */
  saveRefreshedTokens(
    organizationId: string,
    integrationId: string,
    tokens: RefreshedTokens,
    fence: string,
  ): Promise<SaveRefreshedTokensResult>;
  setStatus(
    organizationId: string,
    integrationId: string,
    status: 'active' | 'error',
  ): Promise<void>;
  resolveOrganization(provider: ConnectedProvider, integrationId: string): Promise<string | null>;
  /** App-wide webhook routing by provider account id (GitHub installation id). Identifiers of live rows only. */
  resolveByExternalAccount(
    provider: ConnectedProvider,
    externalAccountId: string,
  ): Promise<{ organizationId: string; id: string }[]>;
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
