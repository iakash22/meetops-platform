import type { Integration, IntegrationIssue, TaskStatus } from '@meetops/contracts';
import {
  createIntegrationConnectionRepository,
  type IntegrationConnectionRecord,
  type IntegrationConnectionRepository,
  type IntegrationSecretCipher,
} from '@meetops/database';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import type {
  ApprovalRef,
  ConnectedProvider,
  ConnectionSecrets,
  ConnectionUpsert,
  ConnectionView,
  IntegrationsRepository,
  RefreshedTokens,
  RefreshSnapshot,
  SaveRefreshedTokensResult,
  TaskRef,
} from './ports.js';

/**
 * Without the integrations runtime (no KEK configured) the repository gets a cipher that refuses every call:
 * list/disconnect still work and nothing can be encrypted or decrypted by accident.
 */
export const refusingCipher: IntegrationSecretCipher = {
  encrypt: () => Promise.reject(new Error('integration token cipher is not configured')),
  decrypt: () => Promise.reject(new Error('integration token cipher is not configured')),
};

export function toIntegration(r: IntegrationConnectionRecord): Integration | null {
  // The contract requires a connector; rows whose connecting user was deleted are not listed.
  if (!r.connectedById || (r.provider !== 'jira' && r.provider !== 'github')) return null;
  return {
    id: r.id,
    organizationId: r.organizationId,
    provider: r.provider,
    status: r.status,
    displayName: r.displayName,
    externalAccountId: r.externalAccountId,
    connectedById: r.connectedById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrismaIntegrations implements IntegrationsRepository {
  private readonly repo: IntegrationConnectionRepository;
  constructor(
    private readonly db: DatabaseClient,
    cipher: IntegrationSecretCipher = refusingCipher,
  ) {
    this.repo = createIntegrationConnectionRepository({ client: db, cipher });
  }
  private org<T>(organizationId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(organizationId, fn, { client: this.db });
  }
  async list(organizationId: string): Promise<Integration[]> {
    return (await this.repo.list(organizationId))
      .map(toIntegration)
      .filter((x): x is Integration => x !== null);
  }
  async disconnect(organizationId: string, id: string): Promise<Integration | null> {
    const r = await this.repo.disconnect(organizationId, id);
    return r ? toIntegration(r) : null;
  }
  async upsert(organizationId: string, input: ConnectionUpsert): Promise<Integration> {
    const r = toIntegration(await this.repo.upsert(organizationId, input));
    if (!r) throw new Error('upserted connection is not representable');
    return r;
  }
  async get(organizationId: string, id: string): Promise<ConnectionView | null> {
    if (!UUID_RE.test(id)) return null;
    const r = await this.repo.get(organizationId, id);
    const i = r ? toIntegration(r) : null;
    return r && i ? { ...i, accessTokenExpiresAt: r.accessTokenExpiresAt } : null;
  }
  readSecrets(organizationId: string, id: string): Promise<ConnectionSecrets | null> {
    return this.repo.readSecrets(organizationId, id);
  }
  async setStatus(organizationId: string, id: string, status: 'active' | 'error') {
    await this.repo.setStatus(organizationId, id, status);
  }
  /** Same fence as the worker sweep (#354/#375): a digest of the stored access-token envelope. */
  async readForRefresh(organizationId: string, id: string): Promise<RefreshSnapshot | null> {
    const snap = await this.repo.readForRefresh(organizationId, id);
    if (!snap) return null;
    return {
      status: snap.connection.status,
      accessTokenExpiresAt: snap.connection.accessTokenExpiresAt,
      secrets: snap.secrets,
      fence: snap.fence,
    };
  }
  saveRefreshedTokens(
    organizationId: string,
    id: string,
    tokens: RefreshedTokens,
    fence: string,
  ): Promise<SaveRefreshedTokensResult> {
    return this.repo.saveRefreshedTokens(organizationId, id, tokens, fence);
  }
  resolveOrganization(provider: ConnectedProvider, id: string) {
    return this.repo.resolveOrganization(provider, id);
  }
  resolveWebhookSecret(provider: ConnectedProvider, id: string) {
    return this.repo.resolveWebhookSecret(provider, id);
  }
  resolveByExternalAccount(provider: ConnectedProvider, externalAccountId: string) {
    return this.repo.resolveByExternalAccount(provider, externalAccountId);
  }
  getTask(organizationId: string, taskId: string): Promise<TaskRef | null> {
    return this.org(organizationId, (tx) =>
      tx.task.findFirst({
        where: { id: taskId, organizationId, deletedAt: null },
        select: { id: true, title: true, description: true, extractedTaskId: true },
      }),
    );
  }
  getApproval(organizationId: string, approvalId: string): Promise<ApprovalRef | null> {
    return this.org(organizationId, (tx) =>
      tx.taskApproval.findFirst({
        where: { id: approvalId, organizationId },
        select: { id: true, extractedTaskId: true, reviewerId: true, decision: true },
      }),
    );
  }
  hasIssueLink(organizationId: string, taskId: string, integrationId: string) {
    return this.org(
      organizationId,
      async (tx) =>
        (await tx.integrationIssue.count({ where: { organizationId, taskId, integrationId } })) > 0,
    );
  }
  createIssueLink(
    organizationId: string,
    l: {
      taskId: string;
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      externalUrl?: string;
    },
  ): Promise<IntegrationIssue> {
    return this.org(organizationId, async (tx) => {
      const r = await tx.integrationIssue.create({
        data: {
          organizationId,
          taskId: l.taskId,
          integration: l.provider,
          integrationId: l.integrationId,
          provider: l.provider,
          externalId: l.externalId,
          externalUrl: l.externalUrl ?? null,
          syncedAt: new Date(),
        },
      });
      return {
        id: r.id,
        organizationId,
        integrationId: l.integrationId,
        taskId: r.taskId,
        provider: l.provider,
        externalId: r.externalId,
        ...(r.externalUrl ? { externalUrl: r.externalUrl } : {}),
        lastKnownStatus: 'open' as const,
        ...(r.syncedAt ? { syncedAt: r.syncedAt.toISOString() } : {}),
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
  applyIssueStatus(
    organizationId: string,
    c: {
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      taskStatus: TaskStatus;
    },
  ): Promise<number> {
    return this.org(organizationId, async (tx) => {
      const links = await tx.integrationIssue.findMany({
        where: {
          organizationId,
          integrationId: c.integrationId,
          provider: c.provider,
          externalId: c.externalId,
        },
        select: { id: true, taskId: true },
      });
      if (!links.length) return 0;
      const now = new Date();
      await tx.task.updateMany({
        where: { organizationId, id: { in: links.map((l) => l.taskId) }, deletedAt: null },
        data: { status: c.taskStatus, completedAt: c.taskStatus === 'done' ? now : null },
      });
      await tx.integrationIssue.updateMany({
        where: { organizationId, id: { in: links.map((l) => l.id) } },
        data: { syncedAt: now },
      });
      return links.length;
    });
  }
}
