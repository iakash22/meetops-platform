import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AUTH_REVOCATIONS_CHANNEL,
  TOKEN_HASH_TEST_VECTORS,
  parseRevocationMessage,
  type AuthRevocationMessage,
} from '@meetops/session-verifier';
import { buildApp, signupAndLogin, Client, SID, type App } from './helpers.js';
import { fakeRedis } from './fake-redis.js';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service.js';
import { defaultModuleDeps } from '../src/modules/index.js';
import { noopRevocationPublisher } from '../src/modules/auth/application/revocations.js';

describe('token hash parity (ADR-011)', () => {
  it('CryptoTokenService.hash matches the shared @meetops/session-verifier vectors', () => {
    const tokens = new CryptoTokenService();
    for (const [input, hash] of TOKEN_HASH_TEST_VECTORS) expect(tokens.hash(input)).toBe(hash);
  });
});

describe('revocation publisher wiring', () => {
  it('defaults to Redis PUBLISH when the client supports it, else a no-op', () => {
    expect(defaultModuleDeps({ redis: fakeRedis() }, { nodeEnv: 'test' }).revocations).not.toBe(
      noopRevocationPublisher,
    );
    expect(defaultModuleDeps({}, { nodeEnv: 'test' }).revocations).toBe(noopRevocationPublisher);
  });
});

describe('meetops:auth:revocations (published after the change is written)', () => {
  let app: App;
  let redis: ReturnType<typeof fakeRedis>;
  beforeEach(async () => {
    redis = fakeRedis();
    app = await buildApp({ redis });
  });
  afterEach(async () => app.close());

  /** Parsed messages since the last call; every one must be on the channel and pass the strict parser. */
  let seen = 0;
  beforeEach(() => void (seen = 0));
  const drain = (): AuthRevocationMessage[] => {
    const out = redis.published.slice(seen).map(({ channel, message }) => {
      expect(channel).toBe(AUTH_REVOCATIONS_CHANNEL);
      const m = parseRevocationMessage(message);
      expect(m, message).not.toBeNull();
      return m!;
    });
    seen = redis.published.length;
    return out;
  };
  const me = async (c: Client) => {
    const s = (await c.get('/auth/session')).json();
    const sessions = (await c.get('/auth/sessions')).json().items as {
      id: string;
      current: boolean;
    }[];
    return { userId: s.user.id as string, sessionId: sessions.find((x) => x.current)!.id };
  };
  const ownerWithOrg = async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const orgId = (await owner.post('/orgs', { name: 'Acme' })).json().organization.id as string;
    return { owner, orgId };
  };
  const join = async (owner: Client, orgId: string, email: string, role: 'admin' | 'member') => {
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const c = await signupAndLogin(app, email);
    expect(
      (await c.post('/invitations/accept', { token: app.token(email, 'invitation')! })).statusCode,
    ).toBe(200);
    return c;
  };

  it('logout: kind session, old session id and active org, ids only', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const { userId, sessionId } = await me(owner);
    const token = owner.jar.get(SID)!;
    drain();
    expect((await owner.post('/auth/logout')).statusCode).toBe(204);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'session',
        sessionId,
        userId,
        organizationId: orgId,
        reason: 'logout',
        at: expect.any(String),
      },
    ]);
    expect(redis.published.map((p) => p.message).join()).not.toContain(token);
  });

  it('logout-all: kind user, reason logout_all', async () => {
    const c = await signupAndLogin(app, 'all@example.com');
    const { userId } = await me(c);
    drain();
    expect((await c.post('/auth/logout-all')).statusCode).toBe(204);
    expect(drain()).toEqual([
      { v: 1, kind: 'user', userId, reason: 'logout_all', at: expect.any(String) },
    ]);
  });

  it('org switch: the OLD session is published with its old org', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const other = (await owner.post('/orgs', { name: 'Beta' })).json().organization.id as string;
    const { userId, sessionId } = await me(owner);
    drain();
    expect((await owner.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'session',
        sessionId,
        userId,
        organizationId: other,
        reason: 'org_switch',
        at: expect.any(String),
      },
    ]);
    expect((await me(owner)).sessionId).not.toBe(sessionId);
  });

  it('member removal: kind membership for the removed user', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const member = await join(owner, orgId, 'gone@example.com', 'member');
    const { userId } = await me(member);
    drain();
    expect((await owner.delete(`/orgs/${orgId}/members/${userId}`)).statusCode).toBe(204);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'membership',
        userId,
        organizationId: orgId,
        reason: 'member_removed',
        at: expect.any(String),
      },
    ]);
  });

  it('role change: kind membership for the target user', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const member = await join(owner, orgId, 'role@example.com', 'member');
    const { userId } = await me(member);
    drain();
    expect(
      (await owner.patch(`/orgs/${orgId}/members/${userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'membership',
        userId,
        organizationId: orgId,
        reason: 'role_changed',
        at: expect.any(String),
      },
    ]);
  });

  it('leaving an org also publishes the rotated-out session', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const member = await join(owner, orgId, 'self@example.com', 'member');
    expect((await member.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    const { userId, sessionId } = await me(member);
    drain();
    expect((await member.delete(`/orgs/${orgId}/members/${userId}`)).statusCode).toBe(204);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'membership',
        userId,
        organizationId: orgId,
        reason: 'member_removed',
        at: expect.any(String),
      },
      {
        v: 1,
        kind: 'session',
        sessionId,
        userId,
        organizationId: orgId,
        reason: 'member_removed',
        at: expect.any(String),
      },
    ]);
  });

  it('invitation revoke: kind membership for an existing invited account; nothing for unknown addresses', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const invitee = await signupAndLogin(app, 'invitee@example.com');
    const { userId } = await me(invitee);
    const inv = (
      await owner.post(`/orgs/${orgId}/invitations`, {
        email: 'invitee@example.com',
        role: 'member',
      })
    ).json();
    const ghost = (
      await owner.post(`/orgs/${orgId}/invitations`, { email: 'ghost@example.com', role: 'member' })
    ).json();
    drain();
    expect((await owner.post(`/orgs/${orgId}/invitations/${inv.id}/revoke`)).statusCode).toBe(200);
    expect(drain()).toEqual([
      {
        v: 1,
        kind: 'membership',
        userId,
        organizationId: orgId,
        reason: 'invitation_revoked',
        at: expect.any(String),
      },
    ]);
    expect((await owner.post(`/orgs/${orgId}/invitations/${ghost.id}/revoke`)).statusCode).toBe(
      200,
    );
    expect(drain()).toEqual([]);
  });

  it('password reset: kind user, reason password_changed', async () => {
    const c = await signupAndLogin(app, 'reset@example.com');
    const { userId } = await me(c);
    const anon = new Client(app);
    await anon.post('/auth/forgot-password', { email: 'reset@example.com' });
    drain();
    const token = app.token('reset@example.com', 'password_reset')!;
    expect(
      (await anon.post('/auth/reset-password', { token, password: 'a-brand-new-password-1' }))
        .statusCode,
    ).toBe(204);
    expect(drain()).toEqual([
      { v: 1, kind: 'user', userId, reason: 'password_changed', at: expect.any(String) },
    ]);
  });

  it('a failing PUBLISH never fails the request (the DB revocation is authoritative)', async () => {
    const c = await signupAndLogin(app, 'flaky@example.com');
    redis.publish = async () => {
      throw new Error('redis down');
    };
    expect((await c.post('/auth/logout')).statusCode).toBe(204);
    expect((await c.get('/auth/session')).statusCode).toBe(401);
  });
});
