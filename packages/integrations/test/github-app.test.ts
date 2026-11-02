import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  createFetchGitHubIssuesClient,
  createGitHubAppJwt,
  GitHubAppClient,
  GitHubAppError,
  GitHubHttpError,
  classifyOctokitError,
} from '../src';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = 1_800_000_000_000;

type Call = {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string };
};
function fakeFetch(
  routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: Call['init']) => {
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const r = routes[key] ?? { status: 404, body: { message: 'nope' } };
    return {
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (n: string) => r.headers?.[n] ?? null },
      text: async () => JSON.stringify(r.body),
    };
  });
  return { fn, calls };
}

const client = (routes: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(routes);
  const c = new GitHubAppClient({
    appId: '123',
    privateKey: async () => pem,
    clientId: 'Iv1.abc',
    clientSecret: async () => 'shh-secret',
    fetch: f.fn,
    now: () => NOW,
  });
  return { c, ...f };
};

describe('createGitHubAppJwt', () => {
  it('signs an RS256 JWT with backdated iat, <=10 min expiry and iss = app id', () => {
    const jwt = createGitHubAppJwt('123', pem, NOW);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '123' });
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
  it('rejects bad app ids and keys without echoing them', () => {
    expect(() => createGitHubAppJwt('abc', pem)).toThrow(GitHubAppError);
    expect(() => createGitHubAppJwt('1', 'not-a-key')).toThrow(/invalid_private_key/);
  });
});

describe('GitHubAppClient', () => {
  it('confirms the installation with the App JWT and mints an installation token', async () => {
    const { c, calls } = client({
      'GET https://api.github.com/app/installations/77': {
        body: { id: 77, account: { login: 'acme', type: 'Organization' } },
      },
      'POST https://api.github.com/app/installations/77/access_tokens': {
        status: 201,
        body: { token: 'ghs_x', expires_at: '2027-01-01T00:00:00Z' },
      },
    });
    expect(await c.getInstallation('77')).toEqual({
      id: '77',
      accountLogin: 'acme',
      accountType: 'Organization',
    });
    expect(await c.createInstallationToken('77')).toEqual({
      token: 'ghs_x',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(calls[0]!.init!.headers!.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls.every((x) => x.init?.redirect === 'error')).toBe(true);
  });
  it('installation-token mint: one timeout covers the body read, and the caller signal aborts it', async () => {
    const mk = (fetch: unknown, timeoutMs?: number) =>
      new GitHubAppClient({
        appId: '123',
        privateKey: async () => pem,
        clientId: 'Iv1.abc',
        clientSecret: async () => 'shh-secret',
        fetch: fetch as never,
        now: () => NOW,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    const stalled = vi.fn(async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: () => new Promise<string>(() => {}),
    }));
    await expect(mk(stalled, 20).createInstallationToken('77')).rejects.toMatchObject({
      code: 'timeout',
    });
    const hang = vi.fn(() => new Promise<never>(() => {}));
    const outer = new AbortController();
    const p = mk(hang, 60_000)
      .createInstallationToken('77', { signal: outer.signal })
      .catch((e: Error) => e);
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    outer.abort();
    expect(await p).toMatchObject({ code: 'timeout' });
  });
  it('rejects an installation that does not match and invalid ids before any request', async () => {
    const { c, fn } = client({
      'GET https://api.github.com/app/installations/77': {
        body: { id: 78, account: { login: 'x' } },
      },
    });
    await expect(c.getInstallation('77')).rejects.toThrow(/invalid_installation/);
    await expect(c.getInstallation('../1')).rejects.toThrow(/invalid_installation_id/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('checks the installing user can access the installation, discarding the user token', async () => {
    const routes = {
      'POST https://github.com/login/oauth/access_token': { body: { access_token: 'ghu_user' } },
      'GET https://api.github.com/user/installations?per_page=100&page=1': {
        body: { installations: [{ id: 5 }, { id: 77 }] },
      },
    };
    const { c, calls } = client(routes);
    expect(await c.userCanAccessInstallation('code123', '77')).toBe(true);
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({
      client_id: 'Iv1.abc',
      client_secret: 'shh-secret',
      code: 'code123',
    });
    expect(calls[1]!.init!.headers!.Authorization).toBe('Bearer ghu_user');
    const other = client(routes);
    expect(await other.c.userCanAccessInstallation('code123', '99')).toBe(false);
  });
  it('fails closed with sanitized errors', async () => {
    const { c } = client({
      'POST https://github.com/login/oauth/access_token': {
        body: { error: 'bad_verification_code' },
      },
    });
    const err = await c.userCanAccessInstallation('code123', '77').catch((e: Error) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect(String((err as Error).message)).not.toMatch(/code123|shh-secret/);
    await expect(c.userCanAccessInstallation('bad code!', '77')).rejects.toThrow(/invalid_code/);
    const down = client({
      'GET https://api.github.com/app/installations/1': { status: 500, body: { secret: 'leak' } },
    });
    await expect(down.c.getInstallation('1')).rejects.toThrow(/http_error \(500\)/);
  });
});

describe('createFetchGitHubIssuesClient', () => {
  it('calls the REST API with the token and maps errors to Octokit-shaped statuses', async () => {
    const f = fakeFetch({
      'POST https://api.github.com/repos/o/r/issues': {
        status: 201,
        body: {
          id: 1,
          number: 3,
          title: 't',
          state: 'open',
          html_url: 'https://github.com/o/r/issues/3',
        },
      },
      'GET https://api.github.com/repos/o/r/issues/4': {
        status: 429,
        body: {},
        headers: { 'retry-after': '2' },
      },
    });
    const gh = createFetchGitHubIssuesClient('ghs_t', { fetch: f.fn });
    const { data } = await gh.rest.issues.create({ owner: 'o', repo: 'r', title: 't' });
    expect(data.number).toBe(3);
    expect(JSON.parse(f.calls[0]!.init!.body!)).toEqual({ title: 't' });
    expect(f.calls[0]!.init!.headers!.Authorization).toBe('Bearer ghs_t');
    const err = await gh.rest.issues
      .get({ owner: 'o', repo: 'r', issue_number: 4 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubHttpError);
    expect(classifyOctokitError(err, 0)).toMatchObject({ retry: true });
    await expect(gh.rest.repos.get({ owner: '../x', repo: 'r' })).rejects.toBeInstanceOf(
      GitHubHttpError,
    );
  });
});
