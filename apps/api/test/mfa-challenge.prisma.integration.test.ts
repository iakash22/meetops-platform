/**
 * ADR-021 OQ-17 against live Postgres as the app role: mfa_challenges single use under concurrency, the attempt cap
 * (reserved by token_hash before the code is checked), user binding, database-clock expiry, and the DB CHECKs
 * (purpose, 5-minute TTL, hash format). Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MFA_CHALLENGE_TTL_SECONDS } from '@meetops/contracts';
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
const DAY_MS = 24 * 60 * 60_000;

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
      Array.from({ length: 30 }, () => svc.submit(challengeToken, now, verify)),
    );
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(verify.mock.calls.length).toBeGreaterThan(0);
    expect(await svc.resolve(challengeToken, new Date())).toBeNull();
    const row = await db.mfaChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.usedAt).not.toBeNull();
    expect(row.attempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
  });

  it('a correct code arriving after 5 reserved failures is rejected without a code check', async () => {
    const now = new Date();
    const { challengeToken, challenge } = await svc.issue(userId, 'password', now);
    for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i++)
      expect(await svc.submit(challengeToken, now, () => false)).toBeNull();
    const verify = vi.fn(() => true);
    expect(await svc.submit(challengeToken, now, verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
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

  it('recordFailure does not keep counting after a burn', async () => {
    const now = new Date();
    const { challengeToken, challenge } = await svc.issue(userId, 'password', now);
    for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i++)
      expect(await svc.submit(challengeToken, now, () => false)).toBeNull();
    for (let i = 0; i < 4; i++)
      expect(await repo.recordFailure(challenge.id, now, MFA_CHALLENGE_MAX_ATTEMPTS)).toBe(
        MFA_CHALLENGE_MAX_ATTEMPTS,
      );
    const row = await db.mfaChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.attempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(row.usedAt).not.toBeNull();
  });

  it('a skewed app clock does not mint, expire, or extend a challenge (DB clock wins)', async () => {
    const past = new Date(Date.now() - DAY_MS);
    const future = new Date(Date.now() + DAY_MS);
    const issuedPast = await svc.issue(userId, 'password', past);
    const issuedFuture = await svc.issue(userId, 'google', future);
    const windowMs = MFA_CHALLENGE_TTL_SECONDS * 1000;
    for (const issued of [issuedPast, issuedFuture]) {
      const age = Date.now() - issued.challenge.createdAt.getTime();
      expect(age).toBeGreaterThan(-10_000);
      expect(age).toBeLessThan(10_000);
      const ttl = issued.expiresAt.getTime() - issued.challenge.createdAt.getTime();
      expect(ttl).toBeGreaterThan(windowMs - 1000);
      expect(ttl).toBeLessThan(windowMs + 1000);
      expect(issued.expiresAt.getTime()).toBeLessThan(Date.now() + windowMs + 10_000);
    }
    // A 24h-past app clock must still see the live row; a 24h-future clock must not treat it as expired.
    expect(await svc.resolve(issuedPast.challengeToken, past)).not.toBeNull();
    expect(await svc.resolve(issuedFuture.challengeToken, future)).not.toBeNull();
    expect(await svc.submit(issuedPast.challengeToken, past, () => true)).not.toBeNull();
    expect(await svc.submit(issuedFuture.challengeToken, future, () => true)).not.toBeNull();
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
