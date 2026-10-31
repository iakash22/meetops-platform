import { describe, it, expect } from 'vitest';
import { EMBEDDING_DIMS, EMBEDDING_MAX_BATCH, embedWithExecutor } from '../src/index.js';
import { fakeLLM, llmCfg, setup } from './helpers.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const vec = (x: number) => new Array<number>(EMBEDDING_DIMS).fill(x);

/** Fake provider with the Embeddings capability. Never calls a real API. */
function fakeEmbedder(dims = EMBEDDING_DIMS) {
  const p = Object.assign(fakeLLM('gemini'), {
    embedCalls: 0,
    lastInputs: [] as string[],
    async embed({ inputs }: { model: string; inputs: string[] }) {
      p.embedCalls++;
      p.lastInputs = inputs;
      return {
        vectors: inputs.map((_, i) => new Array<number>(dims).fill(i + 1)),
        usage: { inputTokens: inputs.length * 3, totalTokens: inputs.length * 3 },
      };
    },
  });
  return p;
}

describe('embedWithExecutor (ai-core embeddings feature)', () => {
  it('is unavailable by default: no default provider declares the embeddings capability', async () => {
    const llm = fakeLLM('gemini');
    const { executor } = await setup({
      providers: { gemini: llm },
      configs: [llmCfg('gemini')],
    });
    const r = await embedWithExecutor(executor, { organizationId: ORG, inputs: ['hello'] });
    expect(r.status).toBe('unavailable');
    expect(llm.calls).toBe(0);
  });

  it('embeds through the executor, records usage and reuses the idempotent result', async () => {
    const p = fakeEmbedder();
    const { executor, usage } = await setup({
      providers: { gemini: p },
      configs: [llmCfg('gemini', { capabilities: ['text-generation', 'embeddings'] })],
    });
    const long = 'x'.repeat(10_000);
    const a = await embedWithExecutor(executor, {
      organizationId: ORG,
      inputs: ['a', long],
      idempotencyKey: 'k1',
    });
    expect(a.status).toBe('succeeded');
    if (a.status !== 'succeeded') return;
    expect(a.vectors).toHaveLength(2);
    expect(a.model).toMatch(/^gemini\//);
    expect(p.lastInputs[1]).toHaveLength(8000);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ organizationId: ORG, provider: 'gemini' });
    expect(usage.records[0]!.usage.totalTokens).toBe(6);
    const b = await embedWithExecutor(executor, {
      organizationId: ORG,
      inputs: ['a', long],
      idempotencyKey: 'k1',
    });
    expect(b.status === 'succeeded' && b.cached).toBe(true);
    expect(p.embedCalls).toBe(1);
  });

  it('refuses wrong-size vectors and oversized batches', async () => {
    const p = fakeEmbedder(8);
    const { executor } = await setup({
      providers: { gemini: p },
      configs: [llmCfg('gemini', { capabilities: ['text-generation', 'embeddings'] })],
    });
    const r = await embedWithExecutor(executor, { organizationId: ORG, inputs: ['a'] });
    expect(r.status).not.toBe('succeeded');
    await expect(
      embedWithExecutor(executor, {
        organizationId: ORG,
        inputs: new Array<string>(EMBEDDING_MAX_BATCH + 1).fill('a'),
      }),
    ).rejects.toThrow(RangeError);
    expect(vec(0)).toHaveLength(EMBEDDING_DIMS);
  });
});
