import type { Integration } from '@meetops/contracts';
import type { IntegrationsRepository } from './ports.js';

/** Dev/test only (selectIntegrationsRepository refuses it outside development/test). */
export class InMemoryIntegrations implements IntegrationsRepository {
  readonly rows = new Map<string, Integration>();
  /** Test hook: secrets are modeled only as presence so tests can assert the wipe. */
  readonly secrets = new Map<string, boolean>();

  add(row: Integration): void {
    this.rows.set(row.id, row);
    this.secrets.set(row.id, row.status !== 'revoked');
  }

  async list(organizationId: string): Promise<Integration[]> {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async disconnect(organizationId: string, id: string): Promise<Integration | null> {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId) return null;
    if (r.status !== 'revoked') {
      const next = { ...r, status: 'revoked' as const, updatedAt: new Date().toISOString() };
      this.rows.set(id, next);
      this.secrets.set(id, false);
      return next;
    }
    return r;
  }
}
