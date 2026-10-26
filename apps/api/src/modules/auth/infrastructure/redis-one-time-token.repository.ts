import type {
  OneTimeToken,
  OneTimeTokenPurpose,
  OneTimeTokenRepository,
} from '../domain/one-time-token.js';
import type { RedisLike } from './rate-limit/redis.js';

type Stored = Omit<OneTimeToken, 'expiresAt' | 'usedAt' | 'createdAt'> & {
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
};

/**
 * Interim production store until email_verifications / password_resets exist
 * (TODO(database P1-DB-3): Prisma adapter with UPDATE ... WHERE used_at IS NULL RETURNING).
 * Single use is atomic via GETDEL on the hash index key: only one consumer can ever read it.
 */
export class RedisOneTimeTokenRepository implements OneTimeTokenRepository {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'meetops:ott:',
  ) {}
  private rowKey = (id: string) => `${this.prefix}t:${id}`;
  private hashKey = (purpose: OneTimeTokenPurpose, h: string) => `${this.prefix}h:${purpose}:${h}`;
  private userKey = (purpose: OneTimeTokenPurpose, userId: string) =>
    `${this.prefix}u:${purpose}:${userId}`;
  private ttl = (t: { expiresAt: number }) => Math.max(1, t.expiresAt - Date.now()) + 60_000;

  private async save(t: Stored) {
    await this.redis.set(this.rowKey(t.id), JSON.stringify(t), 'PX', this.ttl(t));
  }
  private async load(id: string): Promise<Stored | null> {
    const raw = await this.redis.get(this.rowKey(id));
    return raw ? (JSON.parse(raw) as Stored) : null;
  }
  private out = (t: Stored): OneTimeToken => ({
    ...t,
    expiresAt: new Date(t.expiresAt),
    usedAt: t.usedAt === null ? null : new Date(t.usedAt),
    createdAt: new Date(t.createdAt),
  });

  async create(t: OneTimeToken) {
    const s: Stored = {
      ...t,
      expiresAt: t.expiresAt.getTime(),
      usedAt: t.usedAt?.getTime() ?? null,
      createdAt: t.createdAt.getTime(),
    };
    await this.save(s);
    await this.redis.set(this.hashKey(t.purpose, t.tokenHash), t.id, 'PX', this.ttl(s));
    const uk = this.userKey(t.purpose, t.userId);
    await this.redis.sadd(uk, t.id);
    await this.redis.pexpire(uk, this.ttl(s));
    return t;
  }
  async findById(id: string) {
    const t = await this.load(id);
    return t ? this.out(t) : null;
  }
  async setTokenHash(id: string, tokenHash: string) {
    const t = await this.load(id);
    if (!t || t.usedAt) return;
    await this.redis.del(this.hashKey(t.purpose, t.tokenHash));
    t.tokenHash = tokenHash;
    await this.save(t);
    await this.redis.set(this.hashKey(t.purpose, tokenHash), t.id, 'PX', this.ttl(t));
  }
  async consume(purpose: OneTimeTokenPurpose, tokenHash: string, now: Date) {
    const id = await this.redis.getdel(this.hashKey(purpose, tokenHash));
    if (!id) return null;
    const t = await this.load(id);
    if (!t || t.usedAt !== null || t.expiresAt <= now.getTime() || t.purpose !== purpose)
      return null;
    t.usedAt = now.getTime();
    await this.save(t);
    return this.out(t);
  }
  async invalidateForUser(userId: string, purpose: OneTimeTokenPurpose, now: Date) {
    for (const id of await this.redis.smembers(this.userKey(purpose, userId))) {
      const t = await this.load(id);
      if (!t || t.usedAt !== null) continue;
      await this.redis.del(this.hashKey(purpose, t.tokenHash));
      t.usedAt = now.getTime();
      await this.save(t);
    }
  }
}
