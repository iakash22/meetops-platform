import { randomUUID } from 'node:crypto';
import type { Integration, IntegrationIssue, TaskStatus } from '@meetops/contracts';
import type {
  ApprovalRef,
  ConnectedProvider,
  ConnectionSecrets,
  ConnectionUpsert,
  ConnectionView,
  IntegrationsRepository,
  TaskRef,
} from './ports.js';

type Row = Integration & { accessTokenExpiresAt: Date | null };
type TaskRow = TaskRef & { organizationId: string; status: TaskStatus };

/**
 * Dev/test only (selectIntegrationsRepository refuses it outside development/test). Secrets are kept in plaintext
 * in memory because nothing persists; tests assert they never reach responses or audit metadata.
 */
export class InMemoryIntegrations implements IntegrationsRepository {
  readonly rows = new Map<string, Row>();
  /** Test hook: present while the connection has secrets. */
  readonly secrets = new Map<string, ConnectionSecrets | false>();
  readonly tasks = new Map<string, TaskRow>();
  readonly approvals = new Map<string, ApprovalRef & { organizationId: string }>();
  readonly issues: IntegrationIssue[] = [];

  add(
    row: Integration,
    secrets?: ConnectionSecrets,
    accessTokenExpiresAt: Date | null = null,
  ): void {
    this.rows.set(row.id, { ...row, accessTokenExpiresAt });
    this.secrets.set(
      row.id,
      row.status === 'revoked'
        ? false
        : (secrets ?? { accessToken: 'x', refreshToken: null, webhookSecret: 'x' }),
    );
  }

  private view(r: Row | undefined, organizationId: string): Row | null {
    return r && r.organizationId === organizationId ? r : null;
  }
  private dto(row: Row): Integration {
    const r: Partial<Row> = { ...row };
    delete r.accessTokenExpiresAt;
    return r as Integration;
  }

  async list(organizationId: string): Promise<Integration[]> {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((r) => this.dto(r));
  }

  async disconnect(organizationId: string, id: string): Promise<Integration | null> {
    const r = this.view(this.rows.get(id), organizationId);
    if (!r) return null;
    if (r.status !== 'revoked') {
      const next = { ...r, status: 'revoked' as const, updatedAt: new Date().toISOString() };
      this.rows.set(id, next);
      this.secrets.set(id, false);
      return this.dto(next);
    }
    return this.dto(r);
  }

  async upsert(organizationId: string, i: ConnectionUpsert): Promise<Integration> {
    const existing = [...this.rows.values()].find(
      (r) =>
        r.organizationId === organizationId &&
        r.provider === i.provider &&
        r.externalAccountId === i.externalAccountId,
    );
    const now = new Date().toISOString();
    const row: Row = {
      id: existing?.id ?? randomUUID(),
      organizationId,
      provider: i.provider,
      status: 'active',
      displayName: i.displayName,
      externalAccountId: i.externalAccountId,
      connectedById: i.connectedById,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      accessTokenExpiresAt: i.accessTokenExpiresAt,
    };
    this.rows.set(row.id, row);
    this.secrets.set(row.id, {
      accessToken: i.accessToken,
      refreshToken: i.refreshToken,
      webhookSecret: i.webhookSecret,
    });
    return this.dto(row);
  }

  async get(organizationId: string, id: string): Promise<ConnectionView | null> {
    return this.view(this.rows.get(id), organizationId);
  }
  async readSecrets(organizationId: string, id: string): Promise<ConnectionSecrets | null> {
    if (!this.view(this.rows.get(id), organizationId)) return null;
    return this.secrets.get(id) || null;
  }
  async setStatus(organizationId: string, id: string, status: 'active' | 'error') {
    const r = this.view(this.rows.get(id), organizationId);
    if (r && r.status !== 'revoked') this.rows.set(id, { ...r, status });
  }
  async resolveOrganization(provider: ConnectedProvider, id: string) {
    const r = this.rows.get(id);
    return r && r.provider === provider && r.status !== 'revoked' ? r.organizationId : null;
  }
  async getTask(organizationId: string, taskId: string): Promise<TaskRef | null> {
    const t = this.tasks.get(taskId);
    return t && t.organizationId === organizationId
      ? { id: t.id, title: t.title, description: t.description, extractedTaskId: t.extractedTaskId }
      : null;
  }
  async getApproval(organizationId: string, approvalId: string): Promise<ApprovalRef | null> {
    const a = this.approvals.get(approvalId);
    if (!a || a.organizationId !== organizationId) return null;
    const rest: Partial<typeof a> = { ...a };
    delete rest.organizationId;
    return rest as ApprovalRef;
  }
  async hasIssueLink(organizationId: string, taskId: string, integrationId: string) {
    return this.issues.some(
      (i) =>
        i.organizationId === organizationId &&
        i.taskId === taskId &&
        i.integrationId === integrationId,
    );
  }
  async createIssueLink(
    organizationId: string,
    l: {
      taskId: string;
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      externalUrl?: string;
    },
  ): Promise<IntegrationIssue> {
    if (
      this.issues.some(
        (i) =>
          i.organizationId === organizationId &&
          i.provider === l.provider &&
          i.externalId === l.externalId,
      )
    )
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    const now = new Date().toISOString();
    const rec: IntegrationIssue = {
      id: randomUUID(),
      organizationId,
      integrationId: l.integrationId,
      taskId: l.taskId,
      provider: l.provider,
      externalId: l.externalId,
      ...(l.externalUrl ? { externalUrl: l.externalUrl } : {}),
      lastKnownStatus: 'open',
      syncedAt: now,
      createdAt: now,
    };
    this.issues.push(rec);
    return rec;
  }
  async applyIssueStatus(
    organizationId: string,
    c: {
      integrationId: string;
      provider: ConnectedProvider;
      externalId: string;
      taskStatus: TaskStatus;
    },
  ) {
    let n = 0;
    for (const i of this.issues) {
      if (
        i.organizationId !== organizationId ||
        i.integrationId !== c.integrationId ||
        i.provider !== c.provider ||
        i.externalId !== c.externalId
      )
        continue;
      n++;
      i.syncedAt = new Date().toISOString();
      const t = this.tasks.get(i.taskId);
      if (t && t.organizationId === organizationId) t.status = c.taskStatus;
    }
    return n;
  }
}
