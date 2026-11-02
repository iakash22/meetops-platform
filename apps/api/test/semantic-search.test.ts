import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { SemanticSearchResponse } from '@meetops/contracts';
import {
  InMemorySemanticSearch,
  SEMANTIC_EMBEDDING_DIMS,
  SEMANTIC_SEARCH_SQL,
  semanticSearchEnabled,
  toVectorLiteral,
  type QueryEmbedder,
} from '../src/modules/search/semantic.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const MODEL = 'test-embed-1';
/** Deterministic fake embedder: never calls a provider. One-hot on a slot derived from the text. */
const oneHot = (slot: number) => {
  const v = new Array<number>(SEMANTIC_EMBEDDING_DIMS).fill(0);
  v[slot % SEMANTIC_EMBEDDING_DIMS] = 1;
  return v;
};
const fakeEmbedder = (calls: string[]): QueryEmbedder => ({
  model: MODEL,
  embed: async (text) => {
    calls.push(text);
    return oneHot(text.includes('budget') ? 1 : 2);
  },
});

describe('P7 semantic search API', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const url = (org: string, q: string, extra = '') =>
    `/orgs/${org}/search/semantic?q=${encodeURIComponent(q)}${extra}`;

  it('is off by default: the route is not registered (404) and the flag parser is strict', async () => {
    expect(semanticSearchEnabled({})).toBe(false);
    expect(semanticSearchEnabled({ SEMANTIC_SEARCH_ENABLED: '1' })).toBe(false);
    expect(semanticSearchEnabled({ SEMANTIC_SEARCH_ENABLED: ' TRUE ' })).toBe(true);
    const calls: string[] = [];
    app = await buildApp({ queryEmbedder: fakeEmbedder(calls) } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    expect((await c.get(url(org, 'budget review'))).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('flag on without an embedder answers 503 (no provider is ever called)', async () => {
    vi.stubEnv('SEMANTIC_SEARCH_ENABLED', 'true');
    app = await buildApp({});
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    expect((await c.get(url(org, 'budget review'))).statusCode).toBe(503);
  });

  it('an embedder that throws answers 503: no search runs and the provider error never leaks', async () => {
    vi.stubEnv('SEMANTIC_SEARCH_ENABLED', 'true');
    const repo = new InMemorySemanticSearch();
    const search = vi.spyOn(repo, 'search');
    const embed = vi.fn(async (): Promise<number[]> => {
      throw new Error('provider exploded: sk-test-secret upstream 500');
    });
    const embedder: QueryEmbedder = { model: MODEL, embed };
    app = await buildApp({ semanticSearch: repo, queryEmbedder: embedder } as Partial<ModuleDeps>);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const res = await c.get(url(org, 'budget review'));
    expect(res.statusCode).toBe(503);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(res.body).not.toMatch(/provider exploded|sk-test-secret|upstream 500/);
  });

  it('org isolation: ranks only the caller org rows, never another org with an identical vector', async () => {
    vi.stubEnv('SEMANTIC_SEARCH_ENABLED', 'true');
    const repo = new InMemorySemanticSearch();
    const calls: string[] = [];
    app = await buildApp({
      semanticSearch: repo,
      queryEmbedder: fakeEmbedder(calls),
    } as Partial<ModuleDeps>);
    const a = await signupAndLogin(app, 'a@example.com');
    const orgA = await createOrg(a, 'Acme');
    const b = await signupAndLogin(app, 'b@example.com');
    const orgB = await createOrg(b, 'Globex');
    const doc = (organizationId: string, id: string, slot: number, model = MODEL) => ({
      organizationId,
      model,
      vector: oneHot(slot),
      kind: 'transcript' as const,
      id,
      meetingId: '00000000-0000-4000-8000-0000000000aa',
      title: 'Weekly',
      snippet: `text ${id}`,
      startMs: 1000,
      occurredAt: '2026-10-31T10:00:00.000Z',
    });
    const A1 = '00000000-0000-4000-8000-000000000a01';
    const A2 = '00000000-0000-4000-8000-000000000a02';
    const B1 = '00000000-0000-4000-8000-000000000b01';
    const OLD = '00000000-0000-4000-8000-000000000a03';
    repo.docs.push(doc(orgA, A1, 1), doc(orgA, A2, 2), doc(orgB, B1, 1), doc(orgA, OLD, 1, 'old'));

    const r = await a.get(url(orgA, 'budget review'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(Value.Check(SemanticSearchResponse, r.json())).toBe(true);
    const ids = r.json<SemanticSearchResponse>().items.map((i) => i.id);
    expect(ids).toEqual([A1, A2]);
    expect(ids).not.toContain(B1);
    expect(ids).not.toContain(OLD); // other embedding model
    expect(r.json<SemanticSearchResponse>().items[0]!.score).toBe(1);

    // Org B sees only its own row; a non-member using org A's path gets 404 before any embedding.
    const before = calls.length;
    expect((await b.get(url(orgA, 'budget review'))).statusCode).toBe(404);
    expect(calls.length).toBe(before);
    const rb = await b.get(url(orgB, 'budget review'));
    expect(rb.json<SemanticSearchResponse>().items.map((i) => i.id)).toEqual([B1]);
    // kinds filter
    expect((await a.get(url(orgA, 'budget', '&kinds=summary'))).json()).toEqual({ items: [] });
  });

  it('refuses vectors of the wrong size or with non-finite values', () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow();
    expect(() => toVectorLiteral(oneHot(0).map((x, i) => (i === 5 ? NaN : x)))).toThrow();
    expect(toVectorLiteral(oneHot(0)).startsWith('[1,0,')).toBe(true);
  });
});

describe('P7 semantic search query shape (static)', () => {
  const sql = SEMANTIC_SEARCH_SQL.replace(/\s+/g, ' ');
  const scoped = /WITH scoped AS MATERIALIZED \((.*)\) SELECT/.exec(sql)?.[1] ?? '';
  const outer = sql.slice(sql.indexOf(') SELECT') + 1);

  it('filters org_id inside a MATERIALIZED CTE, before any vector ordering', () => {
    expect(scoped).toContain('WHERE e.org_id = $1::uuid AND e.model = $2');
    expect(scoped).not.toMatch(/ORDER BY|<=>|LIMIT/);
    // Every join stays in the same org.
    for (const alias of ['mt', 'sg', 'r']) expect(scoped).toContain(`${alias}.org_id = e.org_id`);
    expect(scoped).toContain('tr.org_id = sg.org_id');
    expect(scoped).toContain('mt.deleted_at IS NULL');
    expect(scoped).toContain('r.deleted_at IS NULL');
    expect(scoped).toContain('sg.revision = tr.revision');
  });

  it('orders by distance only in the outer query over the scoped rows; all values are bound', () => {
    expect(outer).toContain('FROM scoped s ORDER BY s.embedding <=> $3::vector, s.id LIMIT $5');
    expect(outer).not.toMatch(/meeting_embeddings/);
    expect(SEMANTIC_SEARCH_SQL).not.toMatch(/\$\{/);
    expect(sql.match(/meeting_embeddings/g)).toHaveLength(1);
  });

  it('the migration adds no ANN index (which would rank across tenants and post-filter)', () => {
    const mig = readFileSync(
      resolve(
        __dirname,
        '../../../packages/database/prisma/migrations/20261031050000_meeting_embeddings/migration.sql',
      ),
      'utf8',
    ).replace(/--.*$/gm, '');
    expect(mig).not.toMatch(/USING\s+(hnsw|ivfflat)/i);
    expect(mig).toContain('CREATE INDEX "meeting_embeddings_org_id_model_idx"');
  });
});
