import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SearchResponse } from '@meetops/contracts';
import { InMemorySearch } from '../src/modules/search/in-memory.repository.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { PrismaSearch, SearchTimeoutError } from '../src/modules/search/prisma.repository.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

describe('Phase 7 search', () => {
  let app: App;
  let search: InMemorySearch;
  beforeEach(async () => {
    search = new InMemorySearch();
    app = await buildApp({ search } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const seed = (
    organizationId: string,
    kind: 'meeting' | 'transcript' | 'summary' | 'task',
    body: string,
  ) =>
    search.docs.push({
      organizationId,
      kind,
      id: randomUUID(),
      meetingId: randomUUID(),
      title: `${kind} title`,
      body,
      occurredAt: new Date().toISOString(),
    });

  it('returns only the caller org hits, with highlight markers, matching the contract', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Other');
    seed(org, 'transcript', 'We agreed to ship the billing migration on Friday');
    seed(org, 'task', 'Write billing migration runbook');
    seed(otherOrg, 'summary', 'Secret billing migration of the other org');

    const res = await c.get(`/orgs/${org}/search?q=billing%20migration`);
    expect(res.statusCode).toBe(200);
    expect(Value.Check(SearchResponse, res.json())).toBe(true);
    const items = res.json<SearchResponse>().items;
    expect(items.map((i) => i.kind).sort()).toEqual(['task', 'transcript']);
    expect(items[0]!.snippet).toContain('\u0002billing\u0003');
    expect(res.body).not.toContain('other org');
    expect(res.headers['cache-control']).toBe('private, no-store');

    // Another org's id: 404, never its data.
    expect((await c.get(`/orgs/${otherOrg}/search?q=billing`)).statusCode).toBe(404);
  });

  it('filters by kinds and validates input', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    seed(org, 'transcript', 'roadmap review');
    seed(org, 'task', 'roadmap doc');
    const r = await c.get(`/orgs/${org}/search?q=roadmap&kinds=task`);
    expect(r.json<SearchResponse>().items.map((i) => i.kind)).toEqual(['task']);
    expect((await c.get(`/orgs/${org}/search?q=a`)).statusCode).toBe(400);
    expect((await c.get(`/orgs/${org}/search?q=roadmap&kinds=users`)).statusCode).toBe(400);
    expect((await c.get(`/orgs/${org}/search?q=roadmap&limit=500`)).statusCode).toBe(400);
    expect((await c.get(`/orgs/${org}/search?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });

  it('L-1: NUL and control characters are a 400, never a 500', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    for (const q of ['ab%00cd', '%00%00', 'ab%02cd', 'ab%7F']) {
      const r = await c.get(`/orgs/${org}/search?q=${q}`);
      expect(r.statusCode, q).toBe(400);
    }
  });

  it('Info: raw highlight markers in user text cannot fake highlights', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    seed(org, 'task', 'roadmap \u0002fake\u0003 highlight');
    const r = await c.get(`/orgs/${org}/search?q=roadmap`);
    const snippet = r.json<SearchResponse>().items[0]!.snippet;
    expect(snippet).not.toContain('\u0002fake');
    expect(snippet).toContain('\u0002roadmap\u0003');
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/orgs/${randomUUID()}/search?q=hello` });
    expect(res.statusCode).toBe(401);
  });
});

describe('Phase 7 search hardening', () => {
  it('L-2: rate limits per user per org (429)', async () => {
    let n = 0;
    const app = await buildApp({
      search: new InMemorySearch(),
      rateLimiter: {
        consume: (key: string) =>
          Promise.resolve(
            key.startsWith('search:') && ++n > 2
              ? { allowed: false, retryAfterMs: 1000 }
              : { allowed: true, retryAfterMs: 0 },
          ),
      },
    } as Partial<ModuleDeps>);
    try {
      const c = await signupAndLogin(app, 'owner@example.com');
      const org = (await c.post('/orgs', { name: 'Acme' })).json<{ organization: { id: string } }>()
        .organization.id;
      expect((await c.get(`/orgs/${org}/search?q=hello`)).statusCode).toBe(200);
      expect((await c.get(`/orgs/${org}/search?q=hello`)).statusCode).toBe(200);
      expect((await c.get(`/orgs/${org}/search?q=hello`)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('L-2: sets a 2 s statement timeout in the search transaction and maps a timeout to 503', async () => {
    const unsafe: string[] = [];
    const tx = {
      $executeRaw: () => Promise.resolve(1),
      $executeRawUnsafe: (sql: string) => {
        unsafe.push(sql);
        return Promise.resolve(0);
      },
      $queryRaw: () =>
        Promise.reject(
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: 'P2010',
            meta: { code: '57014' },
          }),
        ),
    };
    const db = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const s = new PrismaSearch(db as never);
    await expect(
      s.search(randomUUID(), { q: 'hello', kinds: ['meeting'], limit: 5 }),
    ).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(unsafe).toEqual([`SET LOCAL statement_timeout = '2000ms'`]);
  });
});
