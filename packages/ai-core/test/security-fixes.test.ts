 
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { request } from 'undici';
import {
  createCredentialResolver, pinnedAgent, guardedFetch, toPublicError, AIError, InMemoryOrgConfigStore, ModelRouter,
  ProviderRegistry, aiEnvSchema, type AuditSink, type LLMProvider,
} from '../src/index.js';
import { admin, member, fakeLLM, llmCfg, setup, SYSTEM } from './helpers.js';
import { z } from 'zod';

const schema = z.object({ ok: z.boolean() }).strict();
const call = async (p: unknown, ctx: { model: string }) => {
  const r = await (p as LLMProvider).generateStructured({ model: ctx.model, prompt: 'x', schema, schemaName: 's' });
  return { value: r.value, usage: r.usage };
};

describe('C1: call-time, org-scoped credentials', () => {
  const src = { env: (n: string) => (n === 'GEMINI_API_KEY' ? 'platform-key' : undefined), secret: async (p: string) => (p === 'org/o1/gemini' ? 'byo-o1' : undefined) };
  it('platform keys only when the server-side org plan grants them', async () => {
    const r = createCredentialResolver(src, async (org) => ({ platformKeys: org === 'paid-org' }));
    await expect(r('env:GEMINI_API_KEY', { orgId: 'paid-org' })).resolves.toBe('platform-key');
    await expect(r('env:GEMINI_API_KEY', { orgId: 'free-org' })).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
  });
  it('secret refs bind to org/{orgId}; mismatch rejected', async () => {
    const r = createCredentialResolver(src, async () => ({ platformKeys: true }));
    await expect(r('secret:org/o1/gemini', { orgId: 'o1' })).resolves.toBe('byo-o1');
    await expect(r('secret:org/o1/gemini', { orgId: 'o2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(r('secret:global/gemini', { orgId: 'o1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('adapters are built per call with that org key; failing BYO never falls back to platform key', async () => {
    const s = await setup({
      providers: { gemini: fakeLLM('gemini') },
      configs: [llmCfg('gemini', { credentialRef: 'env:GEMINI_API_KEY' })],
      credentials: { GEMINI_API_KEY: 'platform-key' },
      secrets: { 'org/o1/gemini': 'byo-o1' },
    });
    await s.router.setOrgConfig({ tenantId: 'o1', credentialRefs: { gemini: 'secret:org/o1/gemini' } }, admin('o1'));
    await s.router.setOrgConfig({ tenantId: 'o2', credentialRefs: { gemini: 'secret:org/o2/missing' } }, admin('o2'));
    expect((await s.executor.run({ tenantId: 'o1', feature: 'summary', promptVersion: 'v' }, call)).status).toBe('succeeded');
    expect((await s.executor.run({ tenantId: 'o3', feature: 'summary', promptVersion: 'v' }, call)).status).toBe('succeeded');
    const o2 = await s.executor.run({ tenantId: 'o2', feature: 'summary', promptVersion: 'v' }, call);
    expect(o2.status).toBe('failed');
    expect(s.keysSeen).toEqual(['byo-o1', 'platform-key']); // no platform key used for o2
  });
  it('org cannot reference another org secret', async () => {
    const s = await setup({ providers: {}, configs: [] });
    await expect(s.router.setOrgConfig({ tenantId: 'o1', credentialRefs: { gemini: 'secret:org/o2/k' } }, admin('o1'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('H1: budgets/quotas apply to platform-billed free providers', () => {
  it('free platform-billed provider is quota-limited', async () => {
    const p = fakeLLM('gemini');
    const s = await setup({ providers: { gemini: p }, configs: [llmCfg('gemini', { platformBilled: true, usage: { dailyRequestLimit: 1 } })] });
    await s.executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v' }, call);
    expect((await s.executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v' }, call)).status).toBe('waiting');
    expect(p.calls).toBe(1);
  });
});

describe('H3: authorization + mandatory audit', () => {
  it('setOrgConfig requires owner/admin of the same org', async () => {
    const s = await setup({ providers: {}, configs: [] });
    await expect(s.router.setOrgConfig({ tenantId: 'o1' }, member('o1'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.router.setOrgConfig({ tenantId: 'o1' }, admin('o2'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await s.router.setOrgConfig({ tenantId: 'o1' }, admin('o1', 'user-42'));
    expect(s.audit.events.at(-1)).toMatchObject({ tenantId: 'o1', actorId: 'user-42' });
  });
  it('audit failure aborts the change', async () => {
    const failing: AuditSink = { emit: async () => { throw new Error('db down'); } };
    const store = new InMemoryOrgConfigStore();
    const router = new ModelRouter(aiEnvSchema.parse({}), store, failing);
    await expect(router.setOrgConfig({ tenantId: 'o1' }, admin('o1'))).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    expect(await store.get('o1')).toBeUndefined();
    const reg = new ProviderRegistry({}, async () => 'k', failing);
    await expect(reg.register(llmCfg('x'), SYSTEM)).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    expect(reg.getConfig('x')).toBeUndefined();
  });
  it('register requires a system context', async () => {
    const s = await setup({ providers: {}, configs: [] });
    await expect(s.registry.register(llmCfg('x'), admin('o1') as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('override authorization is server-derived (actor ability), never payload', async () => {
    const s = await setup({ providers: { gemini: fakeLLM('gemini'), alt: fakeLLM('alt') }, configs: [llmCfg('gemini'), llmCfg('alt')] });
    const forged = { provider: 'alt', authorized: true } as never;
    const out = await s.executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v', override: forged }, call);
    expect(out.status).toBe('failed');
    if (out.status !== 'succeeded') expect(out.errors[0]?.code).toBe('UNAUTHORIZED_OVERRIDE');
  });
});

describe('H4: overall deadline across retries', () => {
  it('aborts retries when overall deadline passes', async () => {
    let n = 0;
    const slow = fakeLLM('gemini', () => { n++; return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('x'), { status: 503 })), 30)); });
    const s = await setup({ providers: { gemini: slow }, configs: [llmCfg('gemini', { retryPolicy: { maxAttempts: 5, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 } })] });
    const t0 = Date.now();
    const out = await s.executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v', overallTimeoutMs: 50 }, call);
    expect(out.status).toBe('retryable');
    expect(n).toBeLessThan(5);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('Mediums', () => {
  it('pinned agent connects to the pinned IP regardless of DNS (rebinding defence)', async () => {
    const server = createServer((_q, r) => r.end('pinned-ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const agent = pinnedAgent({ address: '127.0.0.1', family: 4 });
    try {
      // "does-not-resolve.invalid" has no DNS; success proves the connection used the pinned address.
      const res = await request(`http://does-not-resolve.invalid:${port}/`, { dispatcher: agent });
      expect(await res.body.text()).toBe('pinned-ok');
      expect(res.statusCode).toBe(200);
    } finally {
      await agent.close();
      server.close();
    }
  });
  it('streaming byte cap aborts oversized bodies without content-length', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 1000) c.close(); } });
    const f = async () => new Response(stream, { status: 200 });
    await expect(
      guardedFetch({ baseUrl: 'https://api.example.com', policy: { allowedHosts: ['api.example.com'], allowedLocalOrigins: [] }, provider: 'p', fetch: f, lookup: async () => [{ address: '93.184.216.34', family: 4 }], maxResponseBytes: 4096 }, 'x'),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(pulled).toBeLessThan(20);
  });
  it('public errors expose only code + requestId', () => {
    const e = toPublicError(new AIError('MODEL_ERROR', 'upstream said: key sk-123 invalid'), 'req-1');
    expect(e).toEqual({ code: 'MODEL_ERROR', requestId: 'req-1', retryable: true });
    expect(JSON.stringify(e)).not.toContain('sk-123');
  });
  it('job outcomes carry codes only (no provider messages)', async () => {
    const s = await setup({ providers: { gemini: fakeLLM('gemini', () => { throw Object.assign(new Error('secret upstream detail'), { status: 500 }); }) }, configs: [llmCfg('gemini')] });
    const out = await s.executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v', requestId: 'rq' }, call);
    expect(JSON.stringify(out)).not.toContain('secret upstream detail');
    if (out.status !== 'succeeded') expect(out.requestId).toBe('rq');
  });
});
