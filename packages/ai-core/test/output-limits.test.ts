/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles inspect untyped request payloads */
import { describe, expect, it } from 'vitest';
import {
  capOutputTokens, effectiveOutputLimits, providerConfigSchema, DEFAULT_MAX_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS,
  GeminiProvider, OllamaProvider, OpenAICompatibleProvider, ProviderRegistry, InMemoryAuditSink,
} from '../src/index.js';
import { SYSTEM } from './helpers.js';

const pub = async () => [{ address: '142.250.0.1', family: 4 }];
const policy = { allowedHosts: ['generativelanguage.googleapis.com', 'api.openai.com'], allowedLocalOrigins: ['http://localhost:11434'] };
const ORG = '00000000-0000-4000-8000-0000000000c1';

function capture() {
  const bodies: any[] = [];
  const fetch = async (_u: string, i: any) => {
    bodies.push(JSON.parse(String(i?.body)));
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }], // gemini
      choices: [{ message: { content: 'ok' } }], // openai
      message: { content: 'ok' }, // ollama
    });
  };
  return { bodies, fetch };
}
const tokensOf = (b: any) => b.generationConfig?.maxOutputTokens ?? b.max_tokens ?? b.options?.num_predict;

describe('output token caps', () => {
  it('capOutputTokens: default, lower request, clamp to max and hard max', () => {
    expect(capOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(capOutputTokens(100)).toBe(100);
    expect(capOutputTokens(1_000_000)).toBe(HARD_MAX_OUTPUT_TOKENS);
    expect(capOutputTokens(0)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(capOutputTokens(5000, { defaultMaxTokens: 512, maxTokens: 1024 })).toBe(1024);
    expect(capOutputTokens(9000, { defaultMaxTokens: 512, maxTokens: 999_999 })).toBe(HARD_MAX_OUTPUT_TOKENS);
  });

  it('effectiveOutputLimits: per-feature default, never above max', () => {
    const cfg = { defaultMaxTokens: 1024, maxTokens: 4096, perFeature: { summary: 3000, actions: 9000 } };
    expect(effectiveOutputLimits(cfg, 'summary')).toEqual({ defaultMaxTokens: 3000, maxTokens: 4096 });
    expect(effectiveOutputLimits(cfg, 'actions')).toEqual({ defaultMaxTokens: 4096, maxTokens: 4096 });
    expect(effectiveOutputLimits(cfg, 'other')).toEqual({ defaultMaxTokens: 1024, maxTokens: 4096 });
    expect(effectiveOutputLimits(undefined)).toEqual({ defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS, maxTokens: HARD_MAX_OUTPUT_TOKENS });
  });

  it('config rejects limits above the hard max', () => {
    const base = { name: 'gemini', type: 'llm', adapter: 'gemini', model: 'm', cost: { tier: 'free' }, platformBilled: false };
    expect(providerConfigSchema.safeParse({ ...base, outputLimits: { maxTokens: HARD_MAX_OUTPUT_TOKENS + 1 } }).success).toBe(false);
    expect(providerConfigSchema.safeParse({ ...base, outputLimits: { maxTokens: 1024, perFeature: { summary: 512 } } }).success).toBe(true);
  });

  it('every LLM adapter always sends a capped value', async () => {
    const mk = (fetch: any, outputLimits?: any) => [
      new GeminiProvider({ apiKey: 'k', policy, fetch, lookup: pub, outputLimits }),
      new OpenAICompatibleProvider({ baseUrl: 'https://api.openai.com/v1', policy, fetch, lookup: pub, apiKey: 'k', outputLimits }),
      new OllamaProvider({ baseUrl: 'http://localhost:11434', policy, fetch, outputLimits }),
    ];
    const c = capture();
    for (const p of mk(c.fetch)) {
      await p.generateText({ model: 'm', prompt: 'p' });
      await p.generateText({ model: 'm', prompt: 'p', maxTokens: 10_000_000 });
    }
    expect(c.bodies.map(tokensOf)).toEqual([2048, 8192, 2048, 8192, 2048, 8192]);
    const d = capture();
    for (const p of mk(d.fetch, { defaultMaxTokens: 256, maxTokens: 512 })) await p.generateText({ model: 'm', prompt: 'p', maxTokens: 600 });
    expect(d.bodies.map(tokensOf)).toEqual([512, 512, 512]);
  });

  it('registry passes feature-resolved limits to the adapter factory', async () => {
    const seen: any[] = [];
    const reg = new ProviderRegistry({ fake: (_c, _k, o) => { seen.push(o?.outputLimits); return { kind: 'llm' } as any; } }, async () => 'k', new InMemoryAuditSink());
    await reg.register({ name: 'fake', type: 'llm', adapter: 'fake', model: 'm', enabled: true, cost: { tier: 'free' }, platformBilled: false, outputLimits: { defaultMaxTokens: 1000, perFeature: { summary: 1500 } } }, SYSTEM);
    await reg.instantiate('fake', { organizationId: ORG, feature: 'summary' });
    await reg.instantiate('fake', { organizationId: ORG });
    expect(seen).toEqual([{ defaultMaxTokens: 1500, maxTokens: HARD_MAX_OUTPUT_TOKENS }, { defaultMaxTokens: 1000, maxTokens: HARD_MAX_OUTPUT_TOKENS }]);
  });
});
