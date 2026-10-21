import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AIError, planCandidates, type LLMProvider } from '../src/index.js';
import { fakeLLM, fakeSTT, llmCfg, setup } from './helpers.js';

const schema = z.object({ ok: z.boolean() }).strict();
const call = async (p: unknown, ctx: { model: string }) => {
  const r = await (p as LLMProvider).generateStructured({ model: ctx.model, prompt: 'x', schema, schemaName: 's' });
  return { value: { ...r.value, model: ctx.model }, usage: r.usage };
};

describe('precedence: system < env < org < feature < request', () => {
  const s = () =>
    setup({
      providers: { gemini: fakeLLM('gemini'), ollama: fakeLLM('ollama'), openai: fakeLLM('openai'), alt: fakeLLM('alt') },
      configs: [llmCfg('gemini'), llmCfg('ollama', { local: true }), llmCfg('openai'), llmCfg('alt')],
      env: { AI_LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'env-model' },
    });
  it('env beats system', async () => {
    const r = await s().router.resolve('t1', 'summary');
    expect([r.provider, r.model, r.source]).toEqual(['ollama', 'env-model', 'env']);
  });
  it('org beats env, feature beats org, request beats feature', async () => {
    const { router } = s();
    await router.setOrgConfig({ tenantId: 't1', defaults: { llm: { provider: 'gemini', model: 'org-m' } }, features: { actions: { provider: 'alt' } } }, 'admin');
    expect((await router.resolve('t1', 'summary')).source).toBe('organization');
    const f = await router.resolve('t1', 'actions');
    expect([f.provider, f.source]).toEqual(['alt', 'feature']);
    const r = await router.resolve('t1', 'actions', { provider: 'openai', model: 'req-m', authorized: true });
    expect([r.provider, r.model, r.source]).toEqual(['openai', 'req-m', 'request']);
  });
  it('unauthorized request override rejected', async () => {
    await expect(s().router.resolve('t1', 'summary', { provider: 'openai', authorized: false })).rejects.toMatchObject({ code: 'UNAUTHORIZED_OVERRIDE' });
  });
  it('no cross-tenant leakage', async () => {
    const { router } = s();
    await router.setOrgConfig({ tenantId: 'A', defaults: { llm: { provider: 'alt' } } }, 'admin');
    expect((await router.resolve('A', 'summary')).provider).toBe('alt');
    const b = await router.resolve('B', 'summary');
    expect(b.provider).toBe('ollama');
    expect(b.approvedProviders).toEqual([]);
  });
  it('stt features route to stt kind', async () => {
    const r = await s().router.resolve('t1', 'transcription');
    expect([r.kind, r.capability, r.provider]).toEqual(['stt', 'batch-transcription', 'assemblyai']);
  });
});

describe('capabilities & fallback policy', () => {
  it('skips providers lacking capability', async () => {
    const { router, registry } = setup({
      providers: { gemini: fakeLLM('gemini'), txt: fakeLLM('txt') },
      configs: [llmCfg('gemini'), llmCfg('txt', { capabilities: ['text-generation'] })],
    });
    await router.setOrgConfig({ tenantId: 't', defaults: { llm: { provider: 'gemini', fallbacks: ['txt'] } }, approvedProviders: ['gemini', 'txt'] }, 'a');
    const plan = planCandidates(await router.resolve('t', 'actions'), registry);
    expect(plan.candidates.map((c) => c.name)).toEqual(['gemini']);
    expect(plan.skipped[0]).toMatchObject({ provider: 'txt', code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('ZERO paid fallback when AI_ALLOW_PAID_FALLBACK=false', async () => {
    const paid = fakeLLM('openai');
    const { router, executor } = setup({
      providers: { gemini: fakeLLM('gemini', () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); }), openai: paid },
      configs: [llmCfg('gemini'), llmCfg('openai', { cost: { tier: 'paid', inputPer1MTokens: 1 } })],
    });
    await router.setOrgConfig({ tenantId: 't', defaults: { llm: { provider: 'gemini', fallbacks: ['openai'] } }, approvedProviders: ['gemini', 'openai'] }, 'a');
    const out = await executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(paid.calls).toBe(0);
    expect(out.status).toBe('waiting');
    if (out.status !== 'succeeded') {
      expect(out.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['PAID_FALLBACK_BLOCKED', 'QUOTA_EXCEEDED']));
      expect(out.request.tenantId).toBe('t'); // no data loss
    }
  });

  it('paid fallback only when allowed AND explicitly configured', async () => {
    const paid = fakeLLM('openai');
    const { router, executor } = setup({
      providers: { gemini: fakeLLM('gemini', () => { throw Object.assign(new Error('boom'), { status: 500 }); }), openai: paid },
      configs: [llmCfg('gemini'), llmCfg('openai', { cost: { tier: 'paid', inputPer1MTokens: 1 } })],
      env: { AI_ALLOW_PAID_FALLBACK: 'true' },
    });
    await router.setOrgConfig({ tenantId: 't', defaults: { llm: { provider: 'gemini', fallbacks: ['openai'] } }, approvedProviders: ['gemini', 'openai'] }, 'a');
    const out = await executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(out.status).toBe('succeeded');
    expect(paid.calls).toBe(1);
  });

  it('local fallback only when enabled + capable', async () => {
    const local = fakeLLM('ollama');
    const failing = () => { throw Object.assign(new Error('down'), { status: 503 }); };
    const mk = (enabled: boolean) =>
      setup({ providers: { gemini: fakeLLM('gemini', failing), ollama: local }, configs: [llmCfg('gemini'), llmCfg('ollama', { local: true, enabled })] });
    const off = await mk(false).executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(off.status).toBe('retryable');
    const on = await mk(true).executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(on.status).toBe('succeeded');
    if (on.status === 'succeeded') expect(on.meta.provider).toBe('ollama');
  });

  it('unapproved provider is skipped when approval required', async () => {
    const { router, executor, notified } = setup({ providers: { gemini: fakeLLM('gemini'), alt: fakeLLM('alt') }, configs: [llmCfg('gemini'), llmCfg('alt')] });
    await router.setOrgConfig({ tenantId: 't', defaults: { llm: { provider: 'alt' } } }, 'a');
    const out = await executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(out.status).toBe('failed');
    expect(notified).toHaveLength(1);
  });

  it('missing credentials -> failed with clear error, no crash', async () => {
    const { executor } = setup({ providers: { gemini: fakeLLM('gemini') }, configs: [llmCfg('gemini', { credentialRef: 'env:GEMINI_API_KEY' })] });
    const out = await executor.run({ tenantId: 't', feature: 'summary', promptVersion: 'v1' }, call);
    expect(out.status).toBe('failed');
    if (out.status !== 'succeeded') expect(out.errors[0]).toMatchObject({ code: 'MISSING_CREDENTIALS' });
  });

  it('stt routes to stt provider', async () => {
    const { executor } = setup({
      providers: { assemblyai: fakeSTT('assemblyai') },
      configs: [{ name: 'assemblyai', type: 'stt', adapter: 'assemblyai', model: 'u', enabled: true, capabilities: ['batch-transcription'] }],
    });
    const out = await executor.run({ tenantId: 't', feature: 'transcription', promptVersion: 'stt@1', transcriptRevision: 1 }, async (p) => {
      const r = await (p as ReturnType<typeof fakeSTT>).transcribe({ url: 'https://x' });
      return { value: r, usage: { audioSeconds: r.durationSec } };
    });
    expect(out.status).toBe('succeeded');
    if (out.status === 'succeeded') expect(out.meta).toMatchObject({ provider: 'assemblyai', transcriptRevision: 1, usage: { audioSeconds: 60, estimatedCostUsd: 0 } });
  });
  it('AIError is exported', () => expect(new AIError('TIMEOUT', 'x').retryable).toBe(true));
});
