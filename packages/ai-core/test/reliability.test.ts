import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AIError, withRetry, withTimeout, retryPolicySchema, type LLMProvider } from '../src/index.js';
import { admin, fakeLLM, llmCfg, setup } from './helpers.js';

const schema = z.object({ ok: z.boolean() }).strict();
const call = async (p: unknown, ctx: { model: string }) => {
  const r = await (p as LLMProvider).generateStructured({ model: ctx.model, prompt: 'x', schema, schemaName: 's' });
  return { value: r.value, usage: r.usage };
};

describe('timeouts & bounded retries', () => {
  it('times out', async () => {
    await expect(withTimeout(() => new Promise(() => {}), 20)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('retries retryable errors up to maxAttempts only', async () => {
    let n = 0;
    const policy = retryPolicySchema.parse({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 });
    await expect(withRetry(async () => { n++; throw new AIError('RATE_LIMITED', 'x'); }, policy, { sleep: async () => {} })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(n).toBe(3);
  });
  it('does not retry non-retryable', async () => {
    let n = 0;
    const policy = retryPolicySchema.parse({ maxAttempts: 5, initialDelayMs: 0, maxDelayMs: 0 });
    await expect(withRetry(async () => { n++; throw new AIError('MISSING_CREDENTIALS', 'x'); }, policy, { sleep: async () => {} })).rejects.toBeDefined();
    expect(n).toBe(1);
  });
  it('hard cap of 5 even if policy object is tampered', async () => {
    let n = 0;
    await expect(
      withRetry(async () => { n++; throw new AIError('TIMEOUT', 'x'); }, { maxAttempts: 1e9, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 }, { sleep: async () => {} }),
    ).rejects.toBeDefined();
    expect(n).toBe(5);
  });
  it('executor timeout -> retryable status', async () => {
    const { executor } = await setup({ providers: { gemini: fakeLLM('gemini', () => new Promise(() => {})) }, configs: [llmCfg('gemini', { timeoutMs: 100 })] });
    const out = await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v1' }, call);
    expect(out.status).toBe('retryable');
  });
});

describe('usage, quota, budgets, idempotency', () => {
  it('records usage + cost and metadata', async () => {
    const { executor, usage } = await setup({
      providers: { gemini: fakeLLM('gemini') },
      configs: [llmCfg('gemini', { cost: { tier: 'paid', inputPer1MTokens: 1_000_000, outputPer1MTokens: 0 } })],
    });
    const out = await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v7', transcriptRevision: 3 }, call);
    expect(out.status).toBe('succeeded');
    if (out.status === 'succeeded') expect(out.meta).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-lite', promptVersion: 'v7', transcriptRevision: 3, usage: { totalTokens: 15, estimatedCostUsd: 10 } });
    expect(usage.records).toHaveLength(1);
  });
  it('daily request quota blocks before calling -> waiting', async () => {
    const p = fakeLLM('gemini');
    const { executor } = await setup({ providers: { gemini: p }, configs: [llmCfg('gemini', { usage: { dailyRequestLimit: 1 } })] });
    await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v' }, call);
    const out = await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v' }, call);
    expect(out.status).toBe('waiting');
    expect(p.calls).toBe(1);
    // other tenant unaffected
    expect((await executor.run({ tenantId: '00000000-0000-4000-8000-000000000005', feature: 'summary', promptVersion: 'v' }, call)).status).toBe('succeeded');
  });
  it('per-org budget enforced before paid calls', async () => {
    const p = fakeLLM('gemini');
    const { executor, router } = await setup({ providers: { gemini: p }, configs: [llmCfg('gemini', { cost: { tier: 'paid', inputPer1MTokens: 1_000_000 } })] });
    await router.setOrgConfig({ tenantId: '00000000-0000-4000-8000-000000000001', monthlyBudgetUsd: 5 }, admin('00000000-0000-4000-8000-000000000001'));
    expect((await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v' }, call)).status).toBe('succeeded'); // spends $10
    const out = await executor.run({ tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary', promptVersion: 'v' }, call);
    expect(out.status).toBe('waiting');
    expect(p.calls).toBe(1);
  });
  it('idempotency key prevents duplicate AI calls (sequential + concurrent), tenant-scoped', async () => {
    const p = fakeLLM('gemini');
    const { executor } = await setup({ providers: { gemini: p }, configs: [llmCfg('gemini')] });
    const req = { tenantId: '00000000-0000-4000-8000-000000000001', feature: 'summary' as const, promptVersion: 'v', idempotencyKey: 'k1' };
    const [a, b] = await Promise.all([executor.run(req, call), executor.run(req, call)]);
    const c = await executor.run(req, call);
    expect(p.calls).toBe(1);
    expect([a.status, b.status, c.status]).toEqual(['succeeded', 'succeeded', 'succeeded']);
    if (c.status === 'succeeded') expect(c.meta.cached).toBe(true);
    await executor.run({ ...req, tenantId: '00000000-0000-4000-8000-000000000005' }, call);
    expect(p.calls).toBe(2);
  });
});
