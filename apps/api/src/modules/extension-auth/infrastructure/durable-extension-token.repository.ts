import type { ExtensionScope } from '@meetops/contracts';
import { createAuthTokenRepository, type DatabaseClient } from '@meetops/database';
import type {
  AccessTokenRecord,
  ExtensionTokenRepository,
  PairingRecord,
  RefreshConsumeResult,
  TokenFamily,
} from '../domain/extension-token.js';

type DurableStore = ReturnType<typeof createAuthTokenRepository>;

/**
 * ADR-005 A1.2: Redis stays the fast path (hash -> family -> organization lookups, access tokens,
 * pairing codes); Postgres (auth_* tables, forced RLS) is the durable authority for families,
 * revocation and refresh-token single use. Writes go to Postgres first, so a Redis flush can lose
 * sessions (users re-pair) but can never resurrect a revoked family or a consumed refresh token.
 */
export class DurableExtensionTokenRepository implements ExtensionTokenRepository {
  private readonly db: DurableStore;

  constructor(
    private readonly fast: ExtensionTokenRepository,
    db: DatabaseClient | DurableStore,
  ) {
    this.db = 'createFamily' in db ? db : createAuthTokenRepository({ client: db });
  }

  savePairing(p: PairingRecord): Promise<void> {
    return this.fast.savePairing(p);
  }

  consumePairing(codeHash: string): Promise<PairingRecord | null> {
    return this.fast.consumePairing(codeHash);
  }

  async createFamily(f: TokenFamily): Promise<void> {
    await this.db.createFamily(f.organizationId, {
      id: f.id,
      device: {
        userId: f.userId,
        audience: 'extension',
        clientId: f.extensionId,
        deviceId: f.deviceId,
        label: f.deviceLabel,
      },
      scopes: [...f.scopes],
      createdAt: f.createdAt,
      maxExpiresAt: f.maxExpiresAt,
    });
    await this.fast.createFamily(f);
  }

  /** Redis locates the family; Postgres decides whether it is revoked. */
  async findFamily(id: string): Promise<TokenFamily | null> {
    const f = await this.fast.findFamily(id);
    if (!f) return null;
    const durable = await this.db.findFamily(f.organizationId, id);
    if (!durable) return { ...f, revokedAt: f.revokedAt ?? f.createdAt };
    return { ...f, revokedAt: durable.revokedAt ?? f.revokedAt };
  }

  async listFamilies(userId: string, now: Date, organizationId?: string): Promise<TokenFamily[]> {
    const fast = await this.fast.listFamilies(userId, now, organizationId);
    if (!organizationId) return fast;
    const durable = await this.db.listFamilies(organizationId, userId, now, 'extension');
    const byId = new Map(fast.map((f) => [f.id, f]));
    for (const d of durable) {
      if (!byId.has(d.id)) {
        byId.set(d.id, {
          id: d.id,
          userId: d.userId,
          organizationId: d.organizationId,
          extensionId: d.clientId,
          deviceId: d.deviceId,
          deviceLabel: d.deviceLabel,
          scopes: d.scopes as ExtensionScope[],
          createdAt: d.createdAt,
          maxExpiresAt: d.maxExpiresAt,
          revokedAt: d.revokedAt,
        });
      }
    }
    return [...byId.values()];
  }

  async revokeFamily(id: string, at: Date): Promise<void> {
    const f = await this.fast.findFamily(id);
    if (f) await this.db.revokeFamily(f.organizationId, id, at);
    await this.fast.revokeFamily(id, at);
  }

  async saveRefresh(tokenHash: string, familyId: string, expiresAt: Date): Promise<void> {
    const f = await this.fast.findFamily(familyId);
    if (!f) throw new Error('unknown token family');
    await this.db.saveRefresh(f.organizationId, tokenHash, familyId, expiresAt);
    await this.fast.saveRefresh(tokenHash, familyId, expiresAt);
  }

  /** Both stores consume; Postgres is authoritative, so a replay Redis forgot still reads as reuse. */
  async consumeRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    const r = await this.fast.consumeRefresh(tokenHash);
    if (r.status === 'unknown') return r;
    const f = await this.fast.findFamily(r.familyId);
    if (!f) return { status: 'unknown' };
    const d = await this.db.consumeRefresh(f.organizationId, tokenHash, new Date());
    if (d.status === 'unknown') return { status: 'unknown' };
    if (d.status === 'reused' || r.status === 'reused')
      return { status: 'reused', familyId: d.familyId };
    return d;
  }

  peekRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    return this.fast.peekRefresh(tokenHash);
  }

  saveAccess(tokenHash: string, rec: AccessTokenRecord): Promise<void> {
    return this.fast.saveAccess(tokenHash, rec);
  }

  findAccess(tokenHash: string): Promise<AccessTokenRecord | null> {
    return this.fast.findAccess(tokenHash);
  }
}
