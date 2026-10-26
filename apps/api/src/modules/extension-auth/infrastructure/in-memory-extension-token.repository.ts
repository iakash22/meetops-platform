import type {
  AccessTokenRecord,
  ExtensionTokenRepository,
  PairingRecord,
  RefreshConsumeResult,
  TokenFamily,
} from '../domain/extension-token.js';

/** Development/test only. Single-threaded, so consume-by-delete is atomic. */
export class InMemoryExtensionTokenRepository implements ExtensionTokenRepository {
  private pairings = new Map<string, PairingRecord>();
  private families = new Map<string, TokenFamily>();
  private refresh = new Map<string, { familyId: string; consumed: boolean }>();
  private access = new Map<string, AccessTokenRecord>();

  async savePairing(p: PairingRecord) {
    this.pairings.set(p.codeHash, { ...p });
  }
  async consumePairing(codeHash: string) {
    const p = this.pairings.get(codeHash) ?? null;
    this.pairings.delete(codeHash);
    return p;
  }
  async createFamily(f: TokenFamily) {
    this.families.set(f.id, { ...f });
  }
  async findFamily(id: string) {
    const f = this.families.get(id);
    return f ? { ...f } : null;
  }
  async listFamilies(userId: string, now: Date, organizationId?: string) {
    return [...this.families.values()].filter(
      (f) =>
        f.userId === userId &&
        f.revokedAt === null &&
        f.maxExpiresAt > now &&
        (organizationId === undefined || f.organizationId === organizationId),
    );
  }
  async revokeFamily(id: string, at: Date) {
    const f = this.families.get(id);
    if (f && !f.revokedAt) f.revokedAt = at;
  }
  async saveRefresh(tokenHash: string, familyId: string) {
    this.refresh.set(tokenHash, { familyId, consumed: false });
  }
  async consumeRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    const r = this.refresh.get(tokenHash);
    if (!r) return { status: 'unknown' };
    if (r.consumed) return { status: 'reused', familyId: r.familyId };
    r.consumed = true;
    return { status: 'ok', familyId: r.familyId };
  }
  async peekRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    const r = this.refresh.get(tokenHash);
    if (!r) return { status: 'unknown' };
    return { status: r.consumed ? 'reused' : 'ok', familyId: r.familyId };
  }
  async saveAccess(tokenHash: string, rec: AccessTokenRecord) {
    this.access.set(tokenHash, { ...rec });
  }
  async findAccess(tokenHash: string) {
    const a = this.access.get(tokenHash);
    return a ? { ...a } : null;
  }
}
