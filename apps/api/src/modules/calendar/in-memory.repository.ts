import { randomUUID } from 'node:crypto';
import type { CalendarConnection } from '@meetops/contracts';
import type {
  CalendarConnectionsRepository,
  CalendarConnectionUpsert,
  CalendarSecrets,
} from './ports.js';

/** Dev/test only. Holds secrets in process memory (never persisted, never returned by list). */
export class InMemoryCalendarConnections implements CalendarConnectionsRepository {
  readonly rows = new Map<string, CalendarConnection>();
  readonly secrets = new Map<string, CalendarSecrets>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  private mine(organizationId: string, userId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.organizationId === organizationId && r.userId === userId ? r : undefined;
  }
  async listForUser(organizationId: string, userId: string) {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === organizationId && r.userId === userId)
      .sort(
        (a, b) =>
          Number(a.status === 'revoked') - Number(b.status === 'revoked') ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }
  async upsert(organizationId: string, i: CalendarConnectionUpsert) {
    const ts = this.now().toISOString();
    const existing = [...this.rows.values()].find(
      (r) =>
        r.organizationId === organizationId &&
        r.userId === i.userId &&
        r.provider === i.provider &&
        r.externalAccountId === i.externalAccountId,
    );
    const row: CalendarConnection = {
      id: existing?.id ?? randomUUID(),
      organizationId,
      userId: i.userId,
      provider: i.provider,
      status: 'active',
      displayName: i.displayName,
      externalAccountId: i.externalAccountId,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.rows.set(row.id, row);
    this.secrets.set(row.id, {
      accessToken: i.accessToken,
      refreshToken: i.refreshToken,
      accessTokenExpiresAt: i.accessTokenExpiresAt,
    });
    return row;
  }
  async readSecrets(organizationId: string, userId: string, id: string) {
    const r = this.mine(organizationId, userId, id);
    if (!r || r.status === 'revoked') return null;
    return this.secrets.get(id) ?? null;
  }
  async updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
  ) {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId || r.status !== 'active') return;
    this.secrets.set(id, { ...t });
    this.rows.set(id, { ...r, updatedAt: this.now().toISOString() });
  }
  async markError(organizationId: string, id: string) {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId || r.status === 'revoked') return;
    this.rows.set(id, { ...r, status: 'error', updatedAt: this.now().toISOString() });
  }
  async revoke(organizationId: string, userId: string, id: string) {
    const r = this.mine(organizationId, userId, id);
    if (!r || r.status === 'revoked') return false;
    this.secrets.delete(id);
    this.rows.set(id, { ...r, status: 'revoked', updatedAt: this.now().toISOString() });
    return true;
  }
}
