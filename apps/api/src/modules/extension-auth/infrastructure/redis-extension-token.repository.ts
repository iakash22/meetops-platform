import type { ExtensionScope } from '@meetops/contracts';
import type { RedisLike } from '../../auth/infrastructure/rate-limit/redis.js';
import type {
  AccessTokenRecord,
  ExtensionTokenRepository,
  PairingRecord,
  RefreshConsumeResult,
  TokenFamily,
} from '../domain/extension-token.js';

type Json<T> = { [K in keyof T]: T[K] extends Date ? number : T[K] extends Date | null ? number | null : T[K] };

const ms = (d: Date | null) => (d ? d.getTime() : null);
const ttl = (until: number) => Math.max(1, until - Date.now()) + 60_000;

/**
 * Production store until a Prisma table exists (no migration in this change). Keys hold only hashes and ids.
 * Single use is atomic via GETDEL: pairing codes and live refresh tokens can be consumed by exactly one caller.
 * A consumed refresh hash moves to a `used` key so a replay is detected as reuse (ADR-005 A1.2.3).
 */
export class RedisExtensionTokenRepository implements ExtensionTokenRepository {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'meetops:ext:',
  ) {}
  private k = (...parts: string[]) => this.prefix + parts.join(':');

  async savePairing(p: PairingRecord) {
    const v: Json<PairingRecord> = { ...p, expiresAt: p.expiresAt.getTime() };
    await this.redis.set(this.k('pair', p.codeHash), JSON.stringify(v), 'PX', ttl(v.expiresAt));
  }
  async consumePairing(codeHash: string) {
    const raw = await this.redis.getdel(this.k('pair', codeHash));
    if (!raw) return null;
    const v = JSON.parse(raw) as Json<PairingRecord>;
    return { ...v, expiresAt: new Date(v.expiresAt) };
  }

  private async saveFamily(f: TokenFamily) {
    const v: Json<TokenFamily> = { ...f, createdAt: f.createdAt.getTime(), maxExpiresAt: f.maxExpiresAt.getTime(), revokedAt: ms(f.revokedAt) };
    await this.redis.set(this.k('fam', f.id), JSON.stringify(v), 'PX', ttl(v.maxExpiresAt));
  }
  async createFamily(f: TokenFamily) {
    await this.saveFamily(f);
    const uk = this.k('user', f.userId);
    await this.redis.sadd(uk, f.id);
    await this.redis.pexpire(uk, ttl(f.maxExpiresAt.getTime()));
  }
  async findFamily(id: string) {
    const raw = await this.redis.get(this.k('fam', id));
    if (!raw) return null;
    const v = JSON.parse(raw) as Json<TokenFamily>;
    return {
      ...v,
      scopes: v.scopes as ExtensionScope[],
      createdAt: new Date(v.createdAt),
      maxExpiresAt: new Date(v.maxExpiresAt),
      revokedAt: v.revokedAt === null ? null : new Date(v.revokedAt),
    };
  }
  async listFamilies(userId: string, now: Date, organizationId?: string) {
    const out: TokenFamily[] = [];
    for (const id of await this.redis.smembers(this.k('user', userId))) {
      const f = await this.findFamily(id);
      if (!f || f.revokedAt || f.maxExpiresAt <= now) continue;
      if (organizationId !== undefined && f.organizationId !== organizationId) continue;
      out.push(f);
    }
    return out;
  }
  async revokeFamily(id: string, at: Date) {
    const f = await this.findFamily(id);
    if (!f || f.revokedAt) return;
    await this.saveFamily({ ...f, revokedAt: at });
  }
  async saveRefresh(tokenHash: string, familyId: string, expiresAt: Date) {
    await this.redis.set(this.k('rt', tokenHash), familyId, 'PX', ttl(expiresAt.getTime()));
  }
  async consumeRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    const familyId = await this.redis.getdel(this.k('rt', tokenHash));
    if (familyId) {
      const f = await this.findFamily(familyId);
      await this.redis.set(this.k('rtused', tokenHash), familyId, 'PX', ttl(f ? f.maxExpiresAt.getTime() : Date.now()));
      return { status: 'ok', familyId };
    }
    const used = await this.redis.get(this.k('rtused', tokenHash));
    return used ? { status: 'reused', familyId: used } : { status: 'unknown' };
  }
  async peekRefresh(tokenHash: string): Promise<RefreshConsumeResult> {
    const live = await this.redis.get(this.k('rt', tokenHash));
    if (live) return { status: 'ok', familyId: live };
    const used = await this.redis.get(this.k('rtused', tokenHash));
    return used ? { status: 'reused', familyId: used } : { status: 'unknown' };
  }
  async saveAccess(tokenHash: string, rec: AccessTokenRecord) {
    const v: Json<AccessTokenRecord> = { ...rec, expiresAt: rec.expiresAt.getTime() };
    await this.redis.set(this.k('at', tokenHash), JSON.stringify(v), 'PX', ttl(v.expiresAt));
  }
  async findAccess(tokenHash: string) {
    const raw = await this.redis.get(this.k('at', tokenHash));
    if (!raw) return null;
    const v = JSON.parse(raw) as Json<AccessTokenRecord>;
    return { ...v, scopes: v.scopes as ExtensionScope[], expiresAt: new Date(v.expiresAt) };
  }
}
