/** ADR-021 OQ-17: the login MFA challenge is short-lived, single use, single purpose, bound to the user, hash-only. */
import { describe, expect, it, vi } from 'vitest';
import { MFA_CHALLENGE_TTL_SECONDS } from '@meetops/contracts';
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_MS,
  MfaChallengeService,
} from '../src/modules/mfa/domain/challenge.js';
import { InMemoryMfaChallengeRepository } from '../src/modules/mfa/infrastructure/in-memory-mfa-challenge.repository.js';
import {
  CryptoTokenService,
  uuidGenerator,
} from '../src/modules/auth/infrastructure/crypto-token.service.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const t0 = new Date('2026-11-18T06:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

function setup() {
  const challenges = new InMemoryMfaChallengeRepository();
  const tokens = new CryptoTokenService();
  const svc = new MfaChallengeService({ challenges, tokens, ids: uuidGenerator });
  return { challenges, tokens, svc };
}

describe('MfaChallengeService (OQ-17)', () => {
  it('issues a 5-minute, purpose-bound challenge and stores only the SHA-256 of the token', async () => {
    const { challenges, tokens, svc } = setup();
    const issued = await svc.issue(USER, 'password', t0);
    expect(MFA_CHALLENGE_TTL_MS).toBe(MFA_CHALLENGE_TTL_SECONDS * 1000);
    expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(issued.expiresAt.getTime() - t0.getTime()).toBe(5 * 60_000);
    expect(issued.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = [...challenges.items.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      userId: USER,
      purpose: 'mfa_challenge',
      firstFactor: 'password',
    });
    expect(stored[0]!.tokenHash).toBe(tokens.hash(issued.challengeToken));
    expect(JSON.stringify(stored)).not.toContain(issued.challengeToken);
  });

  it('resolves only before expiry, and is single use after a reserved success', async () => {
    const { svc } = setup();
    const { challengeToken } = await svc.issue(USER, 'google', t0);
    const c = await svc.resolve(challengeToken, at(60_000));
    expect(c?.userId).toBe(USER);
    expect(await svc.complete(c!, at(61_000))).toBeNull(); // no reservation yet
    expect(await svc.reserve(c!, at(61_000))).not.toBeNull();
    expect(await svc.complete(c!, at(61_000))).not.toBeNull();
    // Used: neither resolvable nor completable again (a replayed token or a raced second request loses).
    expect(await svc.resolve(challengeToken, at(62_000))).toBeNull();
    expect(await svc.complete(c!, at(62_000))).toBeNull();

    const late = await svc.issue(USER, 'password', t0);
    expect(await svc.resolve(late.challengeToken, at(MFA_CHALLENGE_TTL_MS))).toBeNull();
    const c2 = await svc.resolve(late.challengeToken, at(MFA_CHALLENGE_TTL_MS - 1));
    expect(await svc.reserve(c2!, at(MFA_CHALLENGE_TTL_MS - 1))).not.toBeNull();
    expect(await svc.complete(c2!, at(MFA_CHALLENGE_TTL_MS + 1))).toBeNull();
  });

  it('is bound to its user: completing it for another user fails', async () => {
    const { svc, challenges } = setup();
    const { challengeToken } = await svc.issue(USER, 'password', t0);
    const c = (await svc.resolve(challengeToken, t0))!;
    expect(await svc.reserve(c, t0)).not.toBeNull();
    expect(await challenges.consume(c.id, OTHER, t0)).toBeNull();
    expect(await svc.complete(c, t0)).not.toBeNull();
  });

  it('rejects malformed and unknown tokens without a lookup hit', async () => {
    const { svc } = setup();
    await svc.issue(USER, 'password', t0);
    for (const bad of ['', 'short', 'x'.repeat(200), 'has space'.repeat(5), 'A'.repeat(43)])
      expect(await svc.resolve(bad, t0)).toBeNull();
  });

  it(`burns the challenge after ${MFA_CHALLENGE_MAX_ATTEMPTS} wrong codes and checks the code at most that many times`, async () => {
    const { svc } = setup();
    const { challengeToken } = await svc.issue(USER, 'password', t0);
    const verify = vi.fn(() => false);
    for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i++)
      expect(await svc.submit(challengeToken, t0, verify)).toBeNull();
    expect(verify).toHaveBeenCalledTimes(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(await svc.resolve(challengeToken, t0)).toBeNull();
    expect(await svc.submit(challengeToken, t0, verify)).toBeNull();
    expect(verify).toHaveBeenCalledTimes(MFA_CHALLENGE_MAX_ATTEMPTS);
  });

  it('rejects a correct code after 5 reserved failures without checking it', async () => {
    const { svc } = setup();
    const { challengeToken } = await svc.issue(USER, 'password', t0);
    for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i++)
      expect(await svc.submit(challengeToken, t0, () => false)).toBeNull();
    const verify = vi.fn(() => true);
    expect(await svc.submit(challengeToken, t0, verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('recordFailure does not keep counting after a burn, and consume refuses attempts past the cap', async () => {
    const { svc, challenges } = setup();
    const { challengeToken, challenge } = await svc.issue(USER, 'password', t0);
    for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i++)
      expect(await svc.submit(challengeToken, t0, () => false)).toBeNull();
    const stored = challenges.items.get(challenge.id)!;
    expect(stored.attempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(stored.usedAt).not.toBeNull();
    for (let i = 0; i < 4; i++)
      expect(await challenges.recordFailure(challenge.id, t0, MFA_CHALLENGE_MAX_ATTEMPTS)).toBe(
        MFA_CHALLENGE_MAX_ATTEMPTS,
      );
    expect(challenges.items.get(challenge.id)!.attempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);

    const second = await svc.issue(USER, 'password', t0);
    const c = (await svc.resolve(second.challengeToken, t0))!;
    expect(await svc.reserve(c, t0)).not.toBeNull();
    challenges.items.get(c.id)!.attempts = MFA_CHALLENGE_MAX_ATTEMPTS + 1;
    expect(await svc.complete(c, t0)).toBeNull();
  });

  it('does not check the code when reservation fails, and a further burst cannot exceed the cap', async () => {
    const { svc } = setup();
    const { challengeToken } = await svc.issue(USER, 'password', t0);
    const verify = vi.fn(() => false);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.submit(challengeToken, t0, verify)),
    );
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(MFA_CHALLENGE_MAX_ATTEMPTS);
    expect(await svc.resolve(challengeToken, t0)).toBeNull();
  });

  it('invalidateForUser burns every live challenge of that user only', async () => {
    const { svc } = setup();
    const a = await svc.issue(USER, 'password', t0);
    const b = await svc.issue(OTHER, 'password', t0);
    await svc.invalidateForUser(USER, t0);
    expect(await svc.resolve(a.challengeToken, t0)).toBeNull();
    expect(await svc.resolve(b.challengeToken, t0)).not.toBeNull();
  });
});
