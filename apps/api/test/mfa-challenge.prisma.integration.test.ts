/**
 * ADR-021 OQ-17 against live Postgres as the app role: mfa_challenges single use under concurrency, the attempt cap
 * (reserved before the code is checked), user binding, and the DB CHECKs (purpose, 5-minute TTL, hash format).
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MfaChallengeService,
} from '../src/modules/mfa/domain/challenge.js';
import { PrismaMfaChallengeRepository } from '../src/modules/mfa/infrastructure/prisma-mfa-challenge.repository.js';
import {
  CryptoTokenService,
  uuidGenerator,
} from '../src/modules/auth/infrastructure/crypto-token.service.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('mfa_challenges (live Postgres)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  let repo: PrismaMfaChallengeRepository;
  let svc: MfaChallengeService;
  const userId = randomUUID();
  const otherId = randomUUID();

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    repo = new PrismaMfaChallengeRepository(db);
    svc = new MfaChallengeService({
      challenges: repo,
      tokens: new CryptoTokenService(),
      ids: uuidGenerator,
    });
    for (const id of [userId, otherId])
      await db.user.create({ data: { id, email: `mfa-ch-${id.slice(0, 8)}@example.com` } });
  });
  afterAll(async () => {
    await db?.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await db?.$disconnect();
  });

  it('two concurrent completions after one reservation: exactly one wins', async () => {
    const now = new Date();
    const { challengeToken } = await svc.issue(userId, 'password', now);
    const c = (await svc.resolve(challengeToken, now))!;
    expect(c.userId).toBe(userId);
    expect(await svc.reserve(c, now)).not.toBeNull();
    const results = await Promise.all([svc.complete(c, new Date()), svc.complete(c, new Date())]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await svc.resolve(challengeToken, new Date())).toBeNull();
  });

  it('is bound to its user and stores only the hash', async () => {
    const now = new Date();
    const { challengeToken, challenge } = await svc.issue(userId, 'google', now);
    expect(await repo.consume(challenge.id, otherId, now)).toBeNull();
    const row = await db.mfaChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(challengeToken);
    expect(row).toMatchObject({ purpose: 'mfa_challenge', firstFactor: 'google', usedAt: null });
  });

  it('wrong codes burn it at the cap', async () => {
    const now = new Date();
    const { challengeToken } = await svc.issue(userId, 'password', now);
    const verify = vi.fn(() => false);
    let last: Awaited<ReturnType<typeof svc.submit>> = null;
    for (let i = 0; i < 5; i++) last = await svc.submit(challengeToken, now, verify);
    expect(last).toBeNull();
    expect(verify).toHaveBeenCalledTimes(5);
    expect(await svc.resolve(challengeToken, now)).toBeNull();
  });

  it(`N parallel wrong guesses check the code at most ${MFA_CHALLENGE_MAX_ATTEMPTS} times and burn the challenge`, async () => {
    const now = new Date();
    const { challengeToken, challenge } = await svc.issue(userId, 'password', now);
    const verify = vi.fn(() => false);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.submit(challengeToken, now, verify)),
    );
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(verify.mock.calls.length).toBeGreaterThan(0);
    expect(await svc.resolve(challengeToken, new Date())).toBeNull();
    const row = await db.mfaChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.usedAt).not.toBeNull();
    expect(row.attempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
  });

  it('parallel correct codes give exactly one success', async () => {
    const now = new Date();
    const { challengeToken, challenge } = await svc.issue(userId, 'password', now);
    const verify = vi.fn(() => true);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.submit(challengeToken, now, verify)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(await svc.resolve(challengeToken, new Date())).toBeNull();
    const row = await db.mfaChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.usedAt).not.toBeNull();
  });

  it('DB CHECKs refuse another purpose, a TTL over 5 minutes and a raw (non-hash) token', async () => {
    const now = new Date();
    const base = {
      userId,
      firstFactor: 'password',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const hash = () => randomUUID().replace(/-/g, '').repeat(2);
    await expect(
      db.mfaChallenge.create({ data: { ...base, tokenHash: hash(), purpose: 'session' } }),
    ).rejects.toThrow();
    await expect(
      db.mfaChallenge.create({
        data: {
          ...base,
          tokenHash: hash(),
          expiresAt: new Date(now.getTime() + 5 * 60_000 + 1000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.mfaChallenge.create({ data: { ...base, tokenHash: 'raw-token-not-a-hash' } }),
    ).rejects.toThrow();
    await expect(
      db.mfaChallenge.create({ data: { ...base, tokenHash: hash(), firstFactor: 'mfa' } }),
    ).rejects.toThrow();
  });

  it('invalidateForUser burns live challenges', async () => {
    const now = new Date();
    const { challengeToken } = await svc.issue(userId, 'password', now);
    await svc.invalidateForUser(userId, now);
    expect(await svc.resolve(challengeToken, now)).toBeNull();
  });
});
