import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import {
  ATLASSIAN_ACCESSIBLE_RESOURCES_URL,
  ATLASSIAN_TOKEN_URL,
  GitHubAppInstallFlow,
  InMemoryOAuthStateStore,
  JIRA_OAUTH_SCOPES,
  JiraOAuthClient,
  OAuthStateManager,
  RedisOAuthStateStore,
  assertAllowedRedirect,
  constantTimeEqual,
  createPkcePair,
  toJiraOAuthCredential,
  validateGrantedScopes,
  type FetchLike,
} from '../src';
import { ORG, OTHER_ORG } from './helpers';

const REDIRECT = 'https://app.meetops.test/integrations/jira/callback';
const USER = 'user-1';
const CLOUD = '11111111-2222-4333-8444-555555555555';
const SCOPE = JIRA_OAUTH_SCOPES.join(' ');
const ACCESS = 'placeholder-access';
const REFRESH = 'placeholder-refresh';
const CLIENT_SECRET = 'placeholder-client-secret';

type Res = { status: number; body?: unknown };
function fetchMock(queue: Res[]) {
  return vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error('unexpected fetch');
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { ok: r.status < 300, status: r.status, headers: new Headers(), text: async () => text };
  });
}
const tokenRes = (over: Record<string, unknown> = {}): Res => ({
  status: 200,
  body: {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    scope: SCOPE,
    token_type: 'Bearer',
    ...over,
  },
});
const resourcesRes = (
  list: unknown[] = [
    {
      id: CLOUD,
      url: 'https://acme.atlassian.net',
      name: 'Acme',
      scopes: ['read:jira-work', 'write:jira-work'],
    },
  ],
): Res => ({ status: 200, body: list });

function client(f: ReturnType<typeof fetchMock>, extra: Record<string, unknown> = {}) {
  const store = new InMemoryOAuthStateStore();
  const c = new JiraOAuthClient({
    clientId: 'client-id',
    clientSecret: async () => CLIENT_SECRET,
    redirectUriAllowlist: [REDIRECT],
    stateStore: store,
    fetch: f as unknown as FetchLike,
    now: () => 1_000_000,
    ...extra,
  });
  return { c, store };
}
const who = { organizationId: ORG, userId: USER, redirectUri: REDIRECT };

describe('PKCE + helpers', () => {
  it('creates S256 pairs', () => {
    const p = createPkcePair();
    expect(p.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.codeChallenge).toBe(
      createHash('sha256').update(String(p.codeVerifier)).digest('base64url'),
    );
    expect(createPkcePair().codeVerifier).not.toBe(p.codeVerifier);
  });
  it('constant-time equality and exact redirect allowlist', () => {
    expect(constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual('a', 'ab')).toBe(false);
    expect(() => assertAllowedRedirect(REDIRECT, [REDIRECT])).not.toThrow();
    for (const bad of [
      REDIRECT + '/',
      REDIRECT + '?x=1',
      REDIRECT.toUpperCase(),
      'https://app.meetops.test/integrations/jira',
    ])
      expect(() => assertAllowedRedirect(bad, [REDIRECT])).toThrow();
    expect(() => assertAllowedRedirect('http://evil.test/cb', ['http://evil.test/cb'])).toThrow();
    expect(() =>
      assertAllowedRedirect('http://localhost:3000/cb', ['http://localhost:3000/cb']),
    ).not.toThrow();
  });
  it('validates granted scopes', () => {
    expect(validateGrantedScopes(SCOPE)).toEqual([...JIRA_OAUTH_SCOPES].sort());
    expect(() => validateGrantedScopes('read:jira-work offline_access')).toThrow(
      /insufficient_scope/,
    );
    expect(() => validateGrantedScopes(SCOPE + ' manage:jira-configuration')).toThrow(
      /excess_scope/,
    );
    expect(() => validateGrantedScopes(undefined)).toThrow(/insufficient_scope/);
  });
});

describe('OAuthStateManager', () => {
  it('is single-use, bound to org+user+redirect, and short-lived', async () => {
    let now = 0;
    const m = new OAuthStateManager(new InMemoryOAuthStateStore(() => now), {
      now: () => now,
      ttlSeconds: 99_999,
    });
    const b = { provider: 'jira', ...who };
    const s = await m.issue(b, 'verifier');
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await m.consume(s, b)).codeVerifier).toBe('verifier');
    await expect(m.consume(s, b)).rejects.toMatchObject({ reason: 'invalid_state' });
    const s2 = await m.issue(b);
    await expect(m.consume(s2, { ...b, organizationId: OTHER_ORG })).rejects.toMatchObject({
      reason: 'state_mismatch',
    });
    await expect(m.consume(s2, b)).rejects.toMatchObject({ reason: 'invalid_state' }); // consumed even on mismatch
    const s3 = await m.issue(b);
    now = 901_000; // TTL capped at 900s
    await expect(m.consume(s3, b)).rejects.toMatchObject({ reason: 'invalid_state' });
    await expect(m.consume('short', b)).rejects.toMatchObject({ reason: 'invalid_state' });
    await expect(m.consume(undefined, b)).rejects.toMatchObject({ reason: 'invalid_state' });
  });
  it('stores only a hash of the state in Redis (GETDEL single use)', async () => {
    const redis = new RedisMock();
    const m = new OAuthStateManager(new RedisOAuthStateStore(redis, 't:'));
    const b = { provider: 'jira', ...who };
    const s = await m.issue(b);
    const keys = await redis.keys('t:*');
    expect(keys).toEqual(['t:' + createHash('sha256').update(String(s)).digest('hex')]);
    expect(await redis.ttl(keys[0]!)).toBeLessThanOrEqual(600);
    await m.consume(s, b);
    expect(await redis.keys('t:*')).toEqual([]);
  });
});

describe('JiraOAuthClient', () => {
  it('builds the Atlassian authorize URL with PKCE S256 and minimal scopes', async () => {
    const { c } = client(fetchMock([]));
    const { url, state } = await c.beginAuthorization(who);
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://auth.atlassian.com/authorize');
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      audience: 'api.atlassian.com',
      client_id: 'client-id',
      scope: SCOPE,
      redirect_uri: REDIRECT,
      state,
      response_type: 'code',
      prompt: 'consent',
      code_challenge_method: 'S256',
    });
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(CLIENT_SECRET);
    await expect(
      c.beginAuthorization({ ...who, redirectUri: 'https://evil.test/cb' }),
    ).rejects.toThrow(/allowlist/);
  });
  it('exchanges code with verifier, validates scopes, resolves cloudId', async () => {
    const f = fetchMock([tokenRes(), resourcesRes()]);
    const { c } = client(f);
    const { url, state } = await c.beginAuthorization(who);
    const challenge = new URL(String(url)).searchParams.get('code_challenge');
    const conn = await c.completeAuthorization({ ...who, state, code: 'auth-code' });
    expect(conn).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: 1_000_000 + 3_600_000,
      cloudId: CLOUD,
      siteUrl: 'https://acme.atlassian.net',
      baseUrl: `https://api.atlassian.com/ex/jira/${CLOUD}`,
    });
    const [tokenUrl, init] = f.mock.calls[0] as unknown as [
      string,
      { body: string; redirect: string; method: string },
    ];
    expect(tokenUrl).toBe(ATLASSIAN_TOKEN_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: REDIRECT,
      client_id: 'client-id',
      client_secret: CLIENT_SECRET,
    });
    expect(
      createHash('sha256')
        .update(String((sent as { code_verifier: string }).code_verifier))
        .digest('base64url'),
    ).toBe(challenge);
    const [resUrl, resInit] = f.mock.calls[1] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(resUrl).toBe(ATLASSIAN_ACCESSIBLE_RESOURCES_URL);
    expect(resInit.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(toJiraOAuthCredential(conn)).toEqual({ kind: 'jira-oauth', accessToken: ACCESS });
    // state is single use
    await expect(
      c.completeAuthorization({ ...who, state, code: 'auth-code' }),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
  });
  it('rejects callbacks for another user/org/redirect before calling Atlassian', async () => {
    const f = fetchMock([]);
    const { c } = client(f, { redirectUriAllowlist: [REDIRECT, REDIRECT + '2'] });
    const { state } = await c.beginAuthorization(who);
    await expect(
      c.completeAuthorization({ ...who, userId: 'attacker', state, code: 'x' }),
    ).rejects.toMatchObject({ reason: 'state_mismatch' });
    const s2 = (await c.beginAuthorization(who)).state;
    await expect(
      c.completeAuthorization({ ...who, redirectUri: REDIRECT + '2', state: s2, code: 'x' }),
    ).rejects.toMatchObject({ reason: 'state_mismatch' });
    const s3 = (await c.beginAuthorization(who)).state;
    await expect(
      c.completeAuthorization({ ...who, state: s3, code: 'bad code\n' }),
    ).rejects.toThrow(/invalid_code/);
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects insufficient/excess scopes and missing refresh token', async () => {
    for (const [res, msg] of [
      [tokenRes({ scope: 'read:jira-work offline_access' }), /insufficient_scope/],
      [tokenRes({ scope: SCOPE + ' manage:jira-project' }), /excess_scope/],
      [tokenRes({ refresh_token: undefined }), /missing_refresh_token/],
      [tokenRes({ token_type: 'mac' }), /invalid_token_type/],
      [{ status: 200, body: {} }, /invalid_token_response/],
    ] as const) {
      const { c } = client(fetchMock([res]));
      const { state } = await c.beginAuthorization(who);
      await expect(c.completeAuthorization({ ...who, state, code: 'c' })).rejects.toThrow(msg);
    }
  });
  it('handles multiple / filtered sites and explicit cloudId', async () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const list = [
      { id: CLOUD, url: 'https://acme.atlassian.net', name: 'Acme', scopes: ['read:jira-work'] },
      { id: other, url: 'https://beta.atlassian.net', name: 'Beta', scopes: ['write:jira-work'] },
      { id: 'not-a-uuid', url: 'https://x.atlassian.net', scopes: ['read:jira-work'] },
      {
        id: '33333333-2222-4333-8444-555555555555',
        url: 'https://evil.example.com',
        scopes: ['read:jira-work'],
      },
      {
        id: '44444444-2222-4333-8444-555555555555',
        url: 'https://conf.atlassian.net',
        scopes: ['read:confluence-content.all'],
      },
    ];
    let { c } = client(fetchMock([tokenRes(), resourcesRes(list)]));
    let conn = await c.completeAuthorization({
      ...who,
      state: (await c.beginAuthorization(who)).state,
      code: 'c',
    });
    expect(conn.resources.map((r) => r.cloudId)).toEqual([CLOUD, other]);
    expect(conn.cloudId).toBeUndefined();
    ({ c } = client(fetchMock([tokenRes(), resourcesRes(list)])));
    conn = await c.completeAuthorization({
      ...who,
      cloudId: other,
      state: (await c.beginAuthorization(who)).state,
      code: 'c',
    });
    expect(conn.siteUrl).toBe('https://beta.atlassian.net');
    ({ c } = client(fetchMock([tokenRes(), resourcesRes(list)])));
    await expect(
      c.completeAuthorization({
        ...who,
        cloudId: '33333333-2222-4333-8444-555555555555',
        state: (await c.beginAuthorization(who)).state,
        code: 'c',
      }),
    ).rejects.toThrow(/cloud_not_accessible/);
  });
  it('refreshes with rotation and validates scopes', async () => {
    const f = fetchMock([tokenRes({ access_token: 'new-a', refresh_token: 'new-r' })]);
    const { c } = client(f);
    expect(await c.refresh(REFRESH)).toMatchObject({ accessToken: 'new-a', refreshToken: 'new-r' });
    expect(
      JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body),
    ).toMatchObject({ grant_type: 'refresh_token', refresh_token: REFRESH });
    await expect(
      client(fetchMock([tokenRes({ refresh_token: undefined })])).c.refresh(REFRESH),
    ).rejects.toThrow(/missing_refresh_token/);
    await expect(client(fetchMock([tokenRes()])).c.refresh(REFRESH)).rejects.toThrow(
      /refresh_not_rotated/,
    );
    expect(
      await client(fetchMock([tokenRes({ refresh_token: undefined })]), {
        requireRefreshRotation: false,
      }).c.refresh(REFRESH),
    ).toMatchObject({ refreshToken: REFRESH });
    await expect(
      client(fetchMock([tokenRes({ scope: 'read:jira-work' })])).c.refresh(REFRESH),
    ).rejects.toThrow(/insufficient_scope/);
    await expect(c.refresh('')).rejects.toThrow(/missing_refresh_token/);
  });
  it('sanitizes errors (no tokens, secrets or bodies) and does not retry', async () => {
    const f = fetchMock([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: `bad ${REFRESH} ${CLIENT_SECRET}` },
      },
    ]);
    const err = await client(f)
      .c.refresh(REFRESH)
      .catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'JiraOAuthError', code: 'invalid_grant', status: 400 });
    expect(String((err as Error).message) + JSON.stringify(err)).not.toMatch(/placeholder/);
    expect(f).toHaveBeenCalledTimes(1);
    const weird = await client(fetchMock([{ status: 500, body: { error: 'Has Spaces <script>' } }]))
      .c.refresh(REFRESH)
      .catch((e: Error) => e);
    expect(weird).toMatchObject({ code: 'http_error' });
    const net = vi.fn(async () => {
      throw new Error(`connect ${CLIENT_SECRET}`);
    });
    const nerr = await client(net)
      .c.refresh(REFRESH)
      .catch((e: Error) => e);
    expect(nerr).toMatchObject({ code: 'network_error' });
    expect(net).toHaveBeenCalledTimes(1);
  });
  it('one timeout covers the token request AND the body read (a stalled body cannot hang refresh)', async () => {
    // Headers arrive at once, then the body never finishes: the old code cleared its timer before res.text().
    const stalled = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>(() => {}),
    }));
    const err = await client(stalled, { timeoutMs: 20 })
      .c.refresh(REFRESH)
      .catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'JiraOAuthError', code: 'timeout' });
  });
  it("the caller's AbortSignal aborts the refresh request (fetch gets an aborted signal) and rejects with timeout", async () => {
    let seen: AbortSignal | undefined;
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => {
      seen = init?.signal;
      return new Promise<never>(() => {}); // ignores the signal: the deadline must still win
    });
    const outer = new AbortController();
    const p = client(hang as never, { timeoutMs: 60_000 })
      .c.refresh(REFRESH, { signal: outer.signal })
      .catch((e: Error) => e);
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    outer.abort();
    expect(await p).toMatchObject({ code: 'timeout' });
    expect(seen?.aborted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(
      await client(hang as never)
        .c.refresh(REFRESH, { signal: pre.signal })
        .catch((e: Error) => e),
    ).toMatchObject({ code: 'timeout' });
  });
  it('validates configuration', () => {
    expect(() => client(fetchMock([]), { redirectUriAllowlist: [] })).toThrow();
    expect(() =>
      client(fetchMock([]), { redirectUriAllowlist: ['http://evil.test/cb'] }),
    ).toThrow();
    expect(() => client(fetchMock([]), { clientId: '' })).toThrow();
  });
});

describe('GitHubAppInstallFlow', () => {
  const GH_REDIRECT = 'https://app.meetops.test/integrations/github/setup';
  const flow = () =>
    new GitHubAppInstallFlow({
      appSlug: 'meetops-dev',
      redirectUriAllowlist: [GH_REDIRECT],
      stateStore: new InMemoryOAuthStateStore(),
    });
  const w = { organizationId: ORG, userId: USER, redirectUri: GH_REDIRECT };
  it('issues bound single-use state and validates the callback', async () => {
    const f = flow();
    const { url, state } = await f.begin(w);
    expect(url).toBe(`https://github.com/apps/meetops-dev/installations/new?state=${state}`);
    expect(
      await f.complete({ ...w, state, installationId: '12345', setupAction: 'install' }),
    ).toEqual({ installationId: '12345', setupAction: 'install' });
    await expect(
      f.complete({ ...w, state, installationId: '12345', setupAction: 'install' }),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
    const s2 = (await f.begin(w)).state;
    await expect(
      f.complete({
        ...w,
        organizationId: OTHER_ORG,
        state: s2,
        installationId: '1',
        setupAction: 'install',
      }),
    ).rejects.toMatchObject({ reason: 'state_mismatch' });
    const s3 = (await f.begin(w)).state;
    await expect(
      f.complete({ ...w, state: s3, installationId: '1; drop', setupAction: 'install' }),
    ).rejects.toThrow(/invalid_installation_id/);
    const s4 = (await f.begin(w)).state;
    await expect(
      f.complete({ ...w, state: s4, installationId: '1', setupAction: 'request' }),
    ).rejects.toThrow(/invalid_setup_action/);
    expect(
      () =>
        new GitHubAppInstallFlow({
          appSlug: 'Bad Slug',
          redirectUriAllowlist: [GH_REDIRECT],
          stateStore: new InMemoryOAuthStateStore(),
        }),
    ).toThrow();
  });
});
