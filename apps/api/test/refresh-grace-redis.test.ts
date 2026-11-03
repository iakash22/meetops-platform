import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExtensionRefreshResponse } from '@meetops/contracts';
import {
  RedisRefreshGraceStore,
  openGracePair,
  sealGracePair,
} from '../src/modules/auth/application/refresh-grace.js';
import type { RedisLike } from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service.js';
import {
  ExtensionAuthService,
  type ExtensionAuthDeps,
} from '../src/modules/extension-auth/application/extension-auth.service.js';
import { RedisExtensionTokenRepository } from '../src/modules/extension-auth/index.js';
import { fakeRedis } from './fake-redis.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const NONCE = 'n'.repeat(43);
const META = { ip: null, userAgent: null };

/** Every string value currently stored in the fake (via GET on the keys the store wrote). */
async function storedValues(redis: RedisLike, keys: string[]) {
  return Promise.all(keys.map((k) => redis.get(k)));
}

describe('grace pair sealing', () => {
  it('round-trips only with the same refresh token and binding', () => {
    const sealed = sealGracePair({ accessToken: 'A', refreshToken: 'R' }, 'old-refresh', 'fam:h');
    expect(sealed).not.toContain('old-refresh');
    expect(openGracePair(sealed, 'old-refresh', 'fam:h')).toEqual({
      accessToken: 'A',
      refreshToken: 'R',
    });
    expect(openGracePair(sealed, 'other-token', 'fam:h')).toBeUndefined();
    expect(openGracePair(sealed, 'old-refresh', 'fam:other')).toBeUndefined();
  });
});

describe('RedisRefreshGraceStore', () => {
  it('claims with SET NX, stores the pair encrypted, and replays it for the same device', async () => {
    const redis = fakeRedis();
    const store = new RedisRefreshGraceStore<{ accessToken: string; refreshToken: string }>(
      redis,
      'g:',
    );
    const h = await store.begin('fam', 'h1', 'dev', 'plain-old-refresh');
    // A second claim of the same rotation loses the NX race.
    expect(await redis.set('g:fam:h1', 'x', 'PX', 10_000, 'NX')).toBeNull();
    await h.resolve({ accessToken: 'NEW-ACCESS', refreshToken: 'NEW-REFRESH' });
    const values = await storedValues(redis, ['g:fam:h1', 'g:fam:latest']);
    for (const v of values) {
      expect(v).not.toContain('NEW-ACCESS');
      expect(v).not.toContain('NEW-REFRESH');
      expect(v).not.toContain('plain-old-refresh');
    }
    expect(await store.replay('fam', 'h1', 'dev', 'plain-old-refresh')).toEqual({
      accessToken: 'NEW-ACCESS',
      refreshToken: 'NEW-REFRESH',
    });
    expect(await store.replay('fam', 'h1', 'other-dev', 'plain-old-refresh')).toBeUndefined();
  });

  it('expires after the window and only honours the latest token', async () => {
    const redis = fakeRedis();
    const store = new RedisRefreshGraceStore<string>(redis, 'g:');
    await (await store.begin('fam', 'h1', 'dev', 's1')).resolve('p1');
    await (await store.begin('fam', 'h2', 'dev', 's2')).resolve('p2');
    expect(await store.replay('fam', 'h1', 'dev', 's1')).toBeUndefined();
    expect(await store.replay('fam', 'h2', 'dev', 's2')).toBe('p2');
    redis.advance(10_001);
    expect(await store.replay('fam', 'h2', 'dev', 's2')).toBeUndefined();
  });

  it('waits for an in-flight rotation and reports a failed one as null', async () => {
    const redis = fakeRedis();
    const store = new RedisRefreshGraceStore<string>(redis, 'g:', { pollMs: 5, waitMs: 500 });
    const h = await store.begin('fam', 'h1', 'dev', 's');
    const waiting = store.replay('fam', 'h1', 'dev', 's');
    setTimeout(() => void h.resolve('pair'), 20);
    expect(await waiting).toBe('pair');

    const h2 = await store.begin('fam2', 'h1', 'dev', 's');
    await h2.reject();
    expect(await store.replay('fam2', 'h1', 'dev', 's')).toBeNull();
  });

  it('falls back to this instance when Redis is down', async () => {
    const down = new Proxy(fakeRedis(), {
      get: (t, k) =>
        typeof (t as unknown as Record<string, unknown>)[k as string] === 'function'
          ? () => Promise.reject(new Error('ECONNREFUSED'))
          : (t as unknown as Record<string, unknown>)[k as string],
    }) as RedisLike;
    const a = new RedisRefreshGraceStore<string>(down, 'g:');
    const b = new RedisRefreshGraceStore<string>(down, 'g:');
    await (await a.begin('fam', 'h1', 'dev', 's')).resolve('pair');
    expect(await a.replay('fam', 'h1', 'dev', 's')).toBe('pair');
    // Another instance cannot see it: treated as reuse (fails closed).
    expect(await b.replay('fam', 'h1', 'dev', 's')).toBeUndefined();
  });
});

describe('extension refresh grace across two API instances (shared Redis)', () => {
  function instance(redis: ReturnType<typeof fakeRedis>) {
    const deps = {
      extensionTokens: new RedisExtensionTokenRepository(redis),
      extensionIds: [EXT],
      tokens: new CryptoTokenService(),
      rateLimiter: { consume: async () => ({ allowed: true, retryAfterMs: 0 }) },
      audit: { record: async () => undefined },
      clock: { now: () => new Date() },
      ids: { next: () => randomUUID() },
      organizations: { findById: async () => ({ id: 'org', name: 'Org' }) },
      memberships: { find: async () => ({ deletedAt: null }) },
      refreshGrace: new RedisRefreshGraceStore<ExtensionRefreshResponse>(
        redis,
        'meetops:ext:grace:',
      ),
    } as unknown as ExtensionAuthDeps;
    return { svc: new ExtensionAuthService(deps), repo: deps.extensionTokens, tokens: deps.tokens };
  }

  async function paired(redis: ReturnType<typeof fakeRedis>) {
    const a = instance(redis);
    const b = instance(redis);
    const deviceId = randomUUID();
    const code = a.tokens.generate();
    await a.repo.savePairing({
      codeHash: a.tokens.hash(code),
      nonce: NONCE,
      extensionId: EXT,
      deviceId,
      deviceLabel: null,
      userId: 'u1',
      organizationId: 'org',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const t1 = await a.svc.exchange(
      { pairingCode: code, nonce: NONCE, extensionId: EXT, deviceId },
      META,
    );
    return { a, b, deviceId, t1 };
  }

  it('a retry on instance B gets the same pair instance A issued', async () => {
    const redis = fakeRedis();
    const { a, b, deviceId, t1 } = await paired(redis);
    const body = { extensionId: EXT, deviceId, refreshToken: t1.refreshToken };
    const t2 = await a.svc.refresh(body, META);
    const retry = await b.svc.refresh(body, META);
    expect(retry.accessToken).toBe(t2.accessToken);
    expect(retry.refreshToken).toBe(t2.refreshToken);
    // The family is intact on either instance.
    await expect(
      b.svc.refresh({ ...body, refreshToken: t2.refreshToken }, META),
    ).resolves.toBeTruthy();
  });

  it('another device on instance B still revokes the family', async () => {
    const redis = fakeRedis();
    const { a, b, deviceId, t1 } = await paired(redis);
    const t2 = await a.svc.refresh(
      { extensionId: EXT, deviceId, refreshToken: t1.refreshToken },
      META,
    );
    await expect(
      b.svc.refresh(
        { extensionId: EXT, deviceId: randomUUID(), refreshToken: t1.refreshToken },
        META,
      ),
    ).rejects.toThrow();
    await expect(
      a.svc.refresh({ extensionId: EXT, deviceId, refreshToken: t2.refreshToken }, META),
    ).rejects.toThrow();
  });

  it('after the window, a retry on instance B is reuse and revokes', async () => {
    const redis = fakeRedis();
    const { a, b, deviceId, t1 } = await paired(redis);
    const body = { extensionId: EXT, deviceId, refreshToken: t1.refreshToken };
    const t2 = await a.svc.refresh(body, META);
    redis.advance(10_001);
    await expect(b.svc.refresh(body, META)).rejects.toThrow();
    await expect(a.svc.refresh({ ...body, refreshToken: t2.refreshToken }, META)).rejects.toThrow();
  });
});
