import { describe, expect, it } from 'vitest';
import {
  AIExecutor,
  InMemoryIdempotencyStore,
  InMemoryUsageTracker,
  UsageQuotaManager,
  UsageRecordError,
  type IdempotencyStore,
  type LLMProvider,
  type UsageTracker,
} from '../src/index.js';
import { fakeLLM, llmCfg, setup } from './helpers.js';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const call = async (p: unknown) => {
  const r = await (p as LLMProvider).generateText({ prompt: 'x', model: 'm' });
  return { value: r.text, usage: r.usage };
};
const req = (organizationId = ORG_A, idempotencyKey = 'job-1') => ({
  organizationId,
  feature: 'summary' as const,
  promptVersion: 'v',
  idempotencyKey,
});

/** Two executors sharing one store stand in for two worker processes sharing Postgres. */
async function twoProcesses(
  store: IdempotencyStore,
  provider = fakeLLM('gemini'),
  usage: UsageTracker = new InMemoryUsageTracker(),
) {
  const base = await setup({ providers: { gemini: provider }, configs: [llmCfg('gemini')] });
  const mk = () =>
    new AIExecutor({
      registry: base.registry,
      router: base.router,
      usage,
      quota: new UsageQuotaManager(usage),
      idempotency: store,
      sleep: async () => {},
    });
  return { provider, a: mk(), b: mk() };
}

describe('idempotency across processes (shared store with claim)', () => {
  it('concurrent duplicate requests in two processes make exactly one provider call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = fakeLLM('gemini', async () => {
      await gate;
      return 'done';
    });
    const { a, b } = await twoProcesses(new InMemoryIdempotencyStore(), provider);
    const pa = a.run(req(), call);
    const pb = b.run(req(), call);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const outs = await Promise.all([pa, pb]);
    expect(provider.calls).toBe(1);
    const statuses = outs.map((o) => o.status).sort();
    expect(statuses).toEqual(['retryable', 'succeeded']);
    const dup = outs.find((o) => o.status === 'retryable');
    if (dup && dup.status !== 'succeeded')
      expect(dup.errors).toEqual([{ provider: '-', code: 'DUPLICATE_IN_FLIGHT' }]);
    // The retry is served from the store, still one call.
    const again = await b.run(req(), call);
    expect(again.status).toBe('succeeded');
    if (again.status === 'succeeded') expect(again.meta.cached).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('a stored result survives a "restart" (new executor, same store)', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = await twoProcesses(store);
    await first.a.run(req(), call);
    const second = await twoProcesses(store);
    const out = await second.a.run(req(), call);
    expect(out.status).toBe('succeeded');
    expect(second.provider.calls).toBe(0);
  });

  it('a failed run releases its claim so a retry can call the provider', async () => {
    let fail = true;
    const provider = fakeLLM('gemini', () => {
      if (fail) throw Object.assign(new Error('boom'), { status: 400 });
      return 'ok';
    });
    const { a } = await twoProcesses(new InMemoryIdempotencyStore(), provider);
    expect((await a.run(req(), call)).status).not.toBe('succeeded');
    fail = false;
    expect((await a.run(req(), call)).status).toBe('succeeded');
  });

  it('keys are isolated per organization', async () => {
    const store = new InMemoryIdempotencyStore();
    const { a, provider } = await twoProcesses(store);
    await a.run(req(ORG_A), call);
    await a.run(req(ORG_B), call);
    expect(provider.calls).toBe(2);
    expect(await store.get(ORG_B, 'summary:job-1')).toBeDefined();
    await store.set(ORG_A, 'only-a', { v: 1 });
    expect(await store.get(ORG_B, 'only-a')).toBeUndefined();
    expect(await store.claim(ORG_B, 'only-a', 60)).toBe(true);
  });

  it('expired results and stale claims can be claimed again', async () => {
    let now = 0;
    const store = new InMemoryIdempotencyStore(() => now);
    expect(await store.claim(ORG_A, 'k', 10)).toBe(true);
    expect(await store.claim(ORG_A, 'k', 10)).toBe(false);
    now = 11_000;
    expect(await store.claim(ORG_A, 'k', 10)).toBe(true);
    await store.set(ORG_A, 'k', 'v', 5);
    expect(await store.get(ORG_A, 'k')).toBe('v');
    now = 17_000;
    expect(await store.get(ORG_A, 'k')).toBeUndefined();
    expect(await store.claim(ORG_A, 'k', 10)).toBe(true);
  });
});

describe('fail closed when a durable store is unreachable', () => {
  const down = () => Promise.reject(new Error('ECONNREFUSED'));

  it('idempotency store down: the job fails, no provider call', async () => {
    const store: IdempotencyStore = { get: down, set: down, claim: down, release: down };
    const { a, provider } = await twoProcesses(store);
    await expect(a.run(req(), call)).rejects.toThrow('ECONNREFUSED');
    expect(provider.calls).toBe(0);
  });

  it('usage store down: quota check rejects, no provider call', async () => {
    const usage: UsageTracker = { record: down, totals: down, organizationCostSince: down };
    const { a, provider } = await twoProcesses(
      new InMemoryIdempotencyStore(),
      fakeLLM('gemini'),
      usage,
    );
    await expect(a.run(req(), call)).rejects.toThrow('ECONNREFUSED');
    expect(provider.calls).toBe(0);
  });

  it('usage write fails after a call: the error propagates, no next provider is tried', async () => {
    const inner = new InMemoryUsageTracker();
    const usage: UsageTracker = {
      record: down,
      totals: (q) => inner.totals(q),
      organizationCostSince: (o, s) => inner.organizationCostSince(o, s),
    };
    const primary = fakeLLM('gemini');
    const local = fakeLLM('ollama');
    const base = await setup({
      providers: { gemini: primary, ollama: local },
      configs: [llmCfg('gemini'), llmCfg('ollama', { local: true })],
    });
    const ex = new AIExecutor({
      registry: base.registry,
      router: base.router,
      usage,
      quota: new UsageQuotaManager(usage),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
    });
    await expect(ex.run(req(), call)).rejects.toBeInstanceOf(UsageRecordError);
    expect(primary.calls).toBe(1);
    expect(local.calls).toBe(0);
  });
});

describe('billed but unrecorded: a retry never bills twice', () => {
  const down = () => Promise.reject(new Error('ECONNREFUSED'));
  async function build(store: IdempotencyStore) {
    const provider = fakeLLM('gemini');
    const base = await setup({ providers: { gemini: provider }, configs: [llmCfg('gemini')] });
    const inner = new InMemoryUsageTracker();
    let usageDown = true;
    const usage: UsageTracker = {
      record: (r) => (usageDown ? down() : inner.record(r)),
      totals: (q) => inner.totals(q),
      organizationCostSince: (o, s) => inner.organizationCostSince(o, s),
    };
    const mk = () =>
      new AIExecutor({
        registry: base.registry,
        router: base.router,
        usage,
        quota: new UsageQuotaManager(usage),
        idempotency: store,
        sleep: async () => {},
      });
    return { provider, a: mk(), b: mk(), heal: () => (usageDown = false) };
  }

  it('usage write fails: the result is kept, a retry (other process) is served from the store', async () => {
    const t = await build(new InMemoryIdempotencyStore());
    await expect(t.a.run(req(), call)).rejects.toBeInstanceOf(UsageRecordError);
    t.heal();
    const retry = await t.b.run(req(), call);
    expect(retry.status).toBe('succeeded');
    if (retry.status === 'succeeded') expect(retry.meta.cached).toBe(true);
    expect(t.provider.calls).toBe(1);
  });

  it('usage write and result store both fail: the claim is kept, so a retry does not call again', async () => {
    const inner = new InMemoryIdempotencyStore();
    let setDown = true;
    const released: string[] = [];
    const store: IdempotencyStore = {
      get: (o, k) => inner.get(o, k),
      set: (o, k, v, ttl) => (setDown ? down() : inner.set(o, k, v, ttl)),
      claim: (o, k, ttl) => inner.claim(o, k, ttl),
      release: async (o, k) => {
        released.push(k);
        await inner.release(o, k);
      },
    };
    const t = await build(store);
    await expect(t.a.run(req(), call)).rejects.toBeInstanceOf(UsageRecordError);
    t.heal();
    setDown = false;
    const retry = await t.b.run(req(), call);
    expect(retry.status).toBe('retryable');
    if (retry.status !== 'succeeded') expect(retry.errors[0]?.code).toBe('DUPLICATE_IN_FLIGHT');
    expect(t.provider.calls).toBe(1);
    expect(released).toHaveLength(0);
  });

  it('result store fails after a recorded success: the claim is kept (no re-bill)', async () => {
    const inner = new InMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      get: (o, k) => inner.get(o, k),
      set: down,
      claim: (o, k, ttl) => inner.claim(o, k, ttl),
      release: (o, k) => inner.release(o, k),
    };
    const t = await build(store);
    t.heal();
    await expect(t.a.run(req(), call)).rejects.toThrow('ECONNREFUSED');
    expect((await t.b.run(req(), call)).status).toBe('retryable');
    expect(t.provider.calls).toBe(1);
  });
});

describe('claim TTL must outlive the job deadline', () => {
  it('fails at construction when the claim TTL is not longer than the deadline', async () => {
    const base = await setup({
      providers: { gemini: fakeLLM('gemini') },
      configs: [llmCfg('gemini')],
    });
    const usage = new InMemoryUsageTracker();
    const deps = {
      registry: base.registry,
      router: base.router,
      usage,
      quota: new UsageQuotaManager(usage),
      idempotency: new InMemoryIdempotencyStore(),
    };
    expect(
      () => new AIExecutor({ ...deps, overallTimeoutMs: 600_000, idempotencyClaimTtlSec: 600 }),
    ).toThrow(/claim/i);
    expect(
      () => new AIExecutor({ ...deps, overallTimeoutMs: 600_000, idempotencyClaimTtlSec: 601 }),
    ).not.toThrow();
    // Defaults are consistent (claim = deadline + margin).
    expect(() => new AIExecutor(deps)).not.toThrow();
    // A store without claim() has nothing to check.
    const plain: IdempotencyStore = { get: async () => undefined, set: async () => undefined };
    expect(
      () => new AIExecutor({ ...deps, idempotency: plain, idempotencyClaimTtlSec: 1 }),
    ).not.toThrow();
  });

  it('a request deadline at or beyond the claim TTL is refused before any provider call', async () => {
    const provider = fakeLLM('gemini');
    const base = await setup({ providers: { gemini: provider }, configs: [llmCfg('gemini')] });
    const usage = new InMemoryUsageTracker();
    const ex = new AIExecutor({
      registry: base.registry,
      router: base.router,
      usage,
      quota: new UsageQuotaManager(usage),
      idempotency: new InMemoryIdempotencyStore(),
      idempotencyClaimTtlSec: 60,
      overallTimeoutMs: 30_000,
    });
    await expect(ex.run({ ...req(), overallTimeoutMs: 60_000 }, call)).rejects.toThrow(/claim TTL/);
    expect(provider.calls).toBe(0);
  });
});
