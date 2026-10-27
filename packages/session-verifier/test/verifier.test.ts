import { describe, expect, it } from 'vitest';
import {
  createSessionVerifier,
  hashToken,
  type ExtensionTokenRecord,
  type MembershipRecord,
  type SessionRecord,
  type SessionStore,
} from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-10-25T10:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const COOKIE = 'cookie-token-value';
const BEARER = 'bearer-token-value';

function fixture(
  over: {
    session?: Partial<SessionRecord> | null;
    memberships?: Record<string, MembershipRecord>;
  } = {},
) {
  const session: SessionRecord | null =
    over.session === null
      ? null
      : {
          id: SID,
          userId: USER,
          activeOrganizationId: ORG,
          idleExpiresAt: at(30 * MIN),
          absoluteExpiresAt: at(12 * 60 * MIN),
          lastSeenAt: T0,
          revokedAt: null,
          userDeletedAt: null,
          ...over.session,
        };
  const memberships = over.memberships ?? {
    [`${ORG}:${USER}`]: { role: 'admin', deletedAt: null },
  };
  const calls: { org: string; user: string }[] = [];
  const store: SessionStore = {
    findSessionByTokenHash: async (h) => (h === hashToken(COOKIE) ? session : null),
    findMembership: async (org, user) => {
      calls.push({ org, user });
      return memberships[`${org}:${user}`] ?? null;
    },
  };
  return { store, calls };
}

const clockAt = (ms: number) => ({ now: () => at(ms) });

describe('verifySession (cookie)', () => {
  it('returns the VerifiedSession for a live session with a live membership', async () => {
    const { store, calls } = fixture();
    const v = createSessionVerifier({ sessions: store, clock: clockAt(MIN) });
    expect(await v.verifySession({ cookie: COOKIE })).toEqual({
      userId: USER,
      organizationId: ORG,
      sessionId: SID,
      credential: 'session',
      role: 'admin',
      expiresAt: at(30 * MIN),
    });
    expect(calls).toEqual([{ org: ORG, user: USER }]);
  });

  it('expiresAt is the earliest of idle and absolute expiry', async () => {
    const { store } = fixture({ session: { absoluteExpiresAt: at(10 * MIN) } });
    const v = createSessionVerifier({ sessions: store, clock: clockAt(0) });
    expect((await v.verifySession({ cookie: COOKIE }))?.expiresAt).toEqual(at(10 * MIN));
    const short = createSessionVerifier({
      sessions: fixture().store,
      clock: clockAt(0),
      idleTimeoutMs: 5 * MIN,
    });
    expect((await short.verifySession({ cookie: COOKIE }))?.expiresAt).toEqual(at(5 * MIN));
  });

  it('returns null for an expired (absolute) session', async () => {
    const { store } = fixture({
      session: { absoluteExpiresAt: at(MIN), idleExpiresAt: at(30 * MIN) },
    });
    expect(
      await createSessionVerifier({ sessions: store, clock: clockAt(MIN) }).verifySession({
        cookie: COOKIE,
      }),
    ).toBeNull();
  });

  it('returns null for an idle session (sessions.expires_at passed)', async () => {
    const { store } = fixture({ session: { idleExpiresAt: at(5 * MIN) } });
    expect(
      await createSessionVerifier({ sessions: store, clock: clockAt(5 * MIN) }).verifySession({
        cookie: COOKIE,
      }),
    ).toBeNull();
  });

  it('returns null for an idle session (last_seen_at + idle timeout passed)', async () => {
    const { store } = fixture({ session: { idleExpiresAt: at(60 * MIN) } });
    const v = createSessionVerifier({
      sessions: store,
      clock: clockAt(30 * MIN),
      idleTimeoutMs: 30 * MIN,
    });
    expect(await v.verifySession({ cookie: COOKIE })).toBeNull();
  });

  it('returns null for a revoked session', async () => {
    const { store, calls } = fixture({ session: { revokedAt: T0 } });
    expect(
      await createSessionVerifier({ sessions: store, clock: clockAt(MIN) }).verifySession({
        cookie: COOKIE,
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null for a wrong-org session (membership only in another org)', async () => {
    const { store, calls } = fixture({
      memberships: { [`${OTHER_ORG}:${USER}`]: { role: 'owner', deletedAt: null } },
    });
    expect(
      await createSessionVerifier({ sessions: store, clock: clockAt(MIN) }).verifySession({
        cookie: COOKIE,
      }),
    ).toBeNull();
    expect(calls).toEqual([{ org: ORG, user: USER }]);
  });

  it('returns null with no active org, a soft-deleted membership or a deleted user', async () => {
    const cases = [
      fixture({ session: { activeOrganizationId: null } }),
      fixture({ memberships: { [`${ORG}:${USER}`]: { role: 'member', deletedAt: T0 } } }),
      fixture({ session: { userDeletedAt: T0 } }),
    ];
    for (const { store } of cases) {
      expect(
        await createSessionVerifier({ sessions: store, clock: clockAt(MIN) }).verifySession({
          cookie: COOKIE,
        }),
      ).toBeNull();
    }
  });

  it('returns null for an unknown, empty or oversized cookie', async () => {
    const v = createSessionVerifier({ sessions: fixture().store, clock: clockAt(MIN) });
    expect(await v.verifySession({ cookie: 'nope' })).toBeNull();
    expect(await v.verifySession({ cookie: '' })).toBeNull();
    expect(await v.verifySession({ cookie: 'x'.repeat(513) })).toBeNull();
  });

  it('propagates store errors so callers fail closed and log', async () => {
    const store: SessionStore = {
      findSessionByTokenHash: async () => Promise.reject(new Error('db down')),
      findMembership: async () => null,
    };
    await expect(
      createSessionVerifier({ sessions: store }).verifySession({ cookie: COOKIE }),
    ).rejects.toThrow('db down');
  });

  it('rejects a non-positive idle timeout', () => {
    expect(() => createSessionVerifier({ sessions: fixture().store, idleTimeoutMs: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('verifySessionByHash', () => {
  it('verifies from the stored hash without the raw cookie', async () => {
    const v = createSessionVerifier({ sessions: fixture().store, clock: clockAt(MIN) });
    expect((await v.verifySessionByHash({ cookieHash: hashToken(COOKIE) }))?.sessionId).toBe(SID);
  });

  it('returns null for a malformed hash without touching the store', async () => {
    const store: SessionStore = {
      findSessionByTokenHash: async () => Promise.reject(new Error('must not be called')),
      findMembership: async () => null,
    };
    const v = createSessionVerifier({ sessions: store });
    expect(await v.verifySessionByHash({ cookieHash: COOKIE })).toBeNull();
    expect(await v.verifySessionByHash({ bearerHash: hashToken(BEARER).toUpperCase() })).toBeNull();
  });
});

describe('verifySession (bearer)', () => {
  const token = (over: Partial<ExtensionTokenRecord> = {}): ExtensionTokenRecord => ({
    familyId: 'fam-1',
    userId: USER,
    organizationId: ORG,
    audience: 'extension',
    scopes: ['recordings:write'],
    expiresAt: at(15 * MIN),
    revokedAt: null,
    ...over,
  });
  const withToken = (t: ExtensionTokenRecord | null) =>
    createSessionVerifier({
      sessions: fixture().store,
      clock: clockAt(MIN),
      extensionTokens: { findByTokenHash: async (h) => (h === hashToken(BEARER) ? t : null) },
    });

  it('returns an extension VerifiedSession with scopes and the token expiry', async () => {
    expect(await withToken(token()).verifySession({ bearer: BEARER })).toEqual({
      userId: USER,
      organizationId: ORG,
      sessionId: 'fam-1',
      credential: 'extension',
      role: 'admin',
      scopes: ['recordings:write'],
      expiresAt: at(15 * MIN),
    });
    expect(
      (await withToken(token()).verifySessionByHash({ bearerHash: hashToken(BEARER) }))?.credential,
    ).toBe('extension');
  });

  it('returns null for a non-extension audience, revoked, expired or wrong-org token', async () => {
    expect(
      await withToken(token({ audience: 'api' })).verifySession({ bearer: BEARER }),
    ).toBeNull();
    expect(await withToken(token({ revokedAt: T0 })).verifySession({ bearer: BEARER })).toBeNull();
    expect(
      await withToken(token({ expiresAt: at(MIN) })).verifySession({ bearer: BEARER }),
    ).toBeNull();
    expect(
      await withToken(token({ organizationId: OTHER_ORG })).verifySession({ bearer: BEARER }),
    ).toBeNull();
  });

  it('fails closed (null) when no extension token store is configured', async () => {
    const v = createSessionVerifier({ sessions: fixture().store, clock: clockAt(MIN) });
    expect(await v.verifySession({ bearer: BEARER })).toBeNull();
  });

  it('a cookie is never accepted as a bearer and vice versa', async () => {
    expect(await withToken(token()).verifySession({ bearer: COOKIE })).toBeNull();
    expect(await withToken(token()).verifySession({ cookie: BEARER })).toBeNull();
  });

  describe('desktop audience (ADR-012, opt-in)', () => {
    const desktop = (t: ExtensionTokenRecord | null, aud?: ('extension' | 'desktop')[]) =>
      createSessionVerifier({
        sessions: fixture().store,
        clock: clockAt(MIN),
        extensionTokens: { findByTokenHash: async (h) => (h === hashToken(BEARER) ? t : null) },
        ...(aud ? { bearerAudiences: aud } : {}),
      });

    it('rejects desktop tokens by default (backward compatible)', async () => {
      expect(
        await desktop(token({ audience: 'desktop' })).verifySession({ bearer: BEARER }),
      ).toBeNull();
    });

    it('accepts desktop tokens as credential "desktop" when opted in', async () => {
      const v = desktop(token({ audience: 'desktop', scopes: ['meetings:read'] }), [
        'extension',
        'desktop',
      ]);
      const r = await v.verifySession({ bearer: BEARER });
      expect(r?.credential).toBe('desktop');
      expect(r?.scopes).toEqual(['meetings:read']);
      expect((await v.verifySessionByHash({ bearerHash: hashToken(BEARER) }))?.credential).toBe(
        'desktop',
      );
    });

    it('desktop-only verifier rejects extension tokens', async () => {
      expect(await desktop(token(), ['desktop']).verifySession({ bearer: BEARER })).toBeNull();
    });

    it('revoked or expired desktop tokens fail closed', async () => {
      const aud: ('extension' | 'desktop')[] = ['desktop'];
      expect(
        await desktop(token({ audience: 'desktop', revokedAt: T0 }), aud).verifySession({
          bearer: BEARER,
        }),
      ).toBeNull();
      expect(
        await desktop(token({ audience: 'desktop', expiresAt: at(MIN) }), aud).verifySession({
          bearer: BEARER,
        }),
      ).toBeNull();
    });

    it('throws on an unknown audience', () => {
      expect(() =>
        createSessionVerifier({ sessions: fixture().store, bearerAudiences: ['api' as 'desktop'] }),
      ).toThrow(RangeError);
    });
  });
});
