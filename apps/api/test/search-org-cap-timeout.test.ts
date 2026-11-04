/** Search hardening: per-org rate caps and a wall-clock timeout (503) on both search routes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySearch } from '../src/modules/search/in-memory.repository.js';
import {
  InMemorySemanticSearch,
  SEMANTIC_EMBEDDING_DIMS,
  type QueryEmbedder,
} from '../src/modules/search/semantic.js';
import {
  SEARCH_ORG_RATE_LIMIT,
  SEARCH_REQUEST_TIMEOUT_MS,
  SEMANTIC_SEARCH_ORG_RATE_LIMIT,
  withSearchTimeout,
} from '../src/modules/search/index.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const vec = () => {
  const v = new Array<number>(SEMANTIC_EMBEDDING_DIMS).fill(0);
  v[1] = 1;
  return v;
};
const okEmbedder: QueryEmbedder = { embed: async () => ({ vector: vec(), model: 'm' }) };
const never = <T>() => new Promise<T>(() => undefined);
const createOrg = async (c: Client) =>
  (await c.post('/orgs', { name: 'Acme' })).json<{ organization: { id: string } }>().organization
    .id;

/** Rate limiter that records keys and denies keys matching `deny`. */
const limiter = (deny: RegExp) => {
  const keys: { key: string; limit: number }[] = [];
  return {
    keys,
    rateLimiter: {
      consume: (key: string, limit: number) => {
        keys.push({ key, limit });
        return Promise.resolve(
          deny.test(key)
            ? { allowed: false, retryAfterMs: 1000 }
            : { allowed: true, retryAfterMs: 0 },
        );
      },
    },
  };
};

describe('search per-org caps and timeout', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('full-text: a per-org cap (no user id in the key) applies after the per-user limit -> 429', async () => {
    const l = limiter(/^search-org:/);
    app = await buildApp({
      search: new InMemorySearch(),
      rateLimiter: l.rateLimiter,
    } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c);
    const res = await c.get(`/orgs/${org}/search?q=hello`);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    const searchKeys = l.keys.filter((k) => k.key.startsWith('search'));
    expect(searchKeys.map((k) => k.key)).toEqual([
      expect.stringMatching(new RegExp(`^search:${org}:`)),
      `search-org:${org}`,
    ]);
    expect(searchKeys[1]!.limit).toBe(SEARCH_ORG_RATE_LIMIT.limit);
  });

  it('full-text: a repository that hangs past the budget answers 503, not a hung request', async () => {
    const search = new InMemorySearch();
    search.search = () => never();
    app = await buildApp({ search, searchTimeoutMs: 50 } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c);
    const res = await c.get(`/orgs/${org}/search?q=hello`);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('PROVIDER_UNAVAILABLE');
  });

  it('semantic: per-org embedding cap -> 429 before any embedding call', async () => {
    vi.stubEnv('SEMANTIC_SEARCH_ENABLED', 'true');
    const l = limiter(/^search-org:semantic:/);
    const embed = vi.fn(async () => ({ vector: vec(), model: 'm' }));
    app = await buildApp({
      semanticSearch: new InMemorySemanticSearch(),
      queryEmbedder: { embed },
      rateLimiter: l.rateLimiter,
    } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c);
    const res = await c.get(`/orgs/${org}/search/semantic?q=budget`);
    expect(res.statusCode).toBe(429);
    expect(embed).not.toHaveBeenCalled();
    const cap = l.keys.find((k) => k.key === `search-org:semantic:${org}`);
    expect(cap?.limit).toBe(SEMANTIC_SEARCH_ORG_RATE_LIMIT.limit);
  });

  it('semantic: a hanging embedder or a hanging vector query answers 503', async () => {
    vi.stubEnv('SEMANTIC_SEARCH_ENABLED', 'true');
    const repo = new InMemorySemanticSearch();
    const search = vi.spyOn(repo, 'search');
    app = await buildApp({
      semanticSearch: repo,
      queryEmbedder: { embed: () => never() },
      searchTimeoutMs: 50,
    } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c);
    expect((await c.get(`/orgs/${org}/search/semantic?q=budget`)).statusCode).toBe(503);
    expect(search).not.toHaveBeenCalled();
    await app.close();

    const repo2 = new InMemorySemanticSearch();
    repo2.search = () => never();
    app = await buildApp({
      semanticSearch: repo2,
      queryEmbedder: okEmbedder,
      searchTimeoutMs: 50,
    } as Partial<ModuleDeps>);
    const c2 = await signupAndLogin(app, 'owner@example.com');
    const org2 = await createOrg(c2);
    const res = await c2.get(`/orgs/${org2}/search/semantic?q=budget`);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('PROVIDER_UNAVAILABLE');
  });

  it('withSearchTimeout resolves fast promises and rejects slow ones with the given error', async () => {
    expect(SEARCH_REQUEST_TIMEOUT_MS).toBe(5_000);
    await expect(withSearchTimeout(Promise.resolve(1), 50, () => new Error('t'))).resolves.toBe(1);
    await expect(withSearchTimeout(never(), 10, () => new Error('late'))).rejects.toThrow('late');
  });
});
