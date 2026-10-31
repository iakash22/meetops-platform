import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SearchResponse } from '@meetops/contracts';
import { InMemorySearch } from '../src/modules/search/in-memory.repository.js';
import type { ModuleDeps } from '../src/modules/index.js';
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

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/orgs/${randomUUID()}/search?q=hello` });
    expect(res.statusCode).toBe(401);
  });
});
