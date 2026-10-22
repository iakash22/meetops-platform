/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- test doubles inspect untyped request payloads */
import { describe, expect, it } from 'vitest';
import {
  capOutputTokens, effectiveOutputLimits, providerConfigSchema, DEFAULT_MAX_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS,
  GeminiProvider, OllamaProvider, OpenAICompatibleProvider, ProviderRegistry, InMemoryAuditSink,
  SUMMARY_OUTPUT_LIMITS, defaultProviderConfigs, aiEnvSchema, extractMeeting,
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
    await reg.instantiate('fake', { orgId: ORG, feature: 'summary' });
    await reg.instantiate('fake', { orgId: ORG });
    expect(seen).toEqual([{ defaultMaxTokens: 1500, maxTokens: HARD_MAX_OUTPUT_TOKENS }, { defaultMaxTokens: 1000, maxTokens: HARD_MAX_OUTPUT_TOKENS }]);
  });

  describe('per feature / per step (summary + reduce = 4096, extraction + map = 2048)', () => {
    const cases: Array<[feature: string, step: 'map' | 'reduce' | undefined, expected: number]> = [
      ['summary', undefined, 4096],
      ['summary', 'reduce', 4096],
      ['summary', 'map', 2048],
      ['actions', undefined, 2048],
      ['actions', 'map', 2048],
      ['actions', 'reduce', 4096],
      ['deadlines', undefined, 2048],
    ];
    it.each(cases)('%s / %s -> %i sent by every LLM adapter', async (feature, step, expected) => {
      const limits = effectiveOutputLimits(SUMMARY_OUTPUT_LIMITS, feature);
      const c = capture();
      const adapters = [
        new GeminiProvider({ apiKey: 'k', policy, fetch: c.fetch, lookup: pub, outputLimits: limits }),
        new OpenAICompatibleProvider({ baseUrl: 'https://api.openai.com/v1', policy, fetch: c.fetch, lookup: pub, apiKey: 'k', outputLimits: limits }),
        new OllamaProvider({ baseUrl: 'http://localhost:11434', policy, fetch: c.fetch, outputLimits: limits }),
      ];
      for (const a of adapters) await a.generateText({ model: 'm', prompt: 'p', step });
      expect(c.bodies.map(tokensOf)).toEqual([expected, expected, expected]);
    });

    it('explicit maxTokens still wins but is clamped to the hard max', () => {
      const limits = effectiveOutputLimits(SUMMARY_OUTPUT_LIMITS, 'summary');
      expect(capOutputTokens(1000, limits, 'reduce')).toBe(1000);
      expect(capOutputTokens(50_000, limits, 'reduce')).toBe(HARD_MAX_OUTPUT_TOKENS);
    });

    it('feature-specific step override beats the generic step default', () => {
      const l = effectiveOutputLimits({ perStep: { reduce: 4096 }, perFeatureStep: { actions: { reduce: 3000 } } }, 'actions');
      expect(capOutputTokens(undefined, l, 'reduce')).toBe(3000);
      expect(capOutputTokens(undefined, effectiveOutputLimits({ perStep: { reduce: 4096 }, maxTokens: 1024 }, 'x'), 'reduce')).toBe(1024);
    });

    it('extractMeeting tags map and reduce calls with their step', async () => {
      const steps: Array<string | undefined> = [];
      const llm: any = {
        providerId: 'p', kind: 'llm',
        generateStructured: async (p: any) => {
          steps.push(p.step);
          return p.schemaName === 'meeting_reduce'
            ? { value: { summary: 's', keyPoints: [] }, usage: {} }
            : { value: { summary: 's', decisions: [], actionItems: [] }, usage: {} };
        },
      };
      const segs = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, startSec: i, endSec: i + 1, speaker: 'S1', text: 'word '.repeat(60) }));
      await extractMeeting(llm, segs, { model: 'm', transcriptRevision: 1, windowTokenBudget: 300 });
      expect(steps.filter((s) => s === 'map').length).toBeGreaterThan(1);
      expect(steps.at(-1)).toBe('reduce');
      expect(steps.every((s) => s === 'map' || s === 'reduce')).toBe(true);
    });

    it('defaults are wired into every LLM provider config and validate', () => {
      const env = aiEnvSchema.parse({});
      const llms = defaultProviderConfigs(env).filter((c) => c.type === 'llm');
      expect(llms.length).toBeGreaterThan(0);
      for (const c of llms) {
        expect(c.outputLimits).toEqual(SUMMARY_OUTPUT_LIMITS);
        expect(providerConfigSchema.safeParse(c).success).toBe(true);
      }
    });

    it('rejects any per-feature / per-step value above the 8192 hard max', () => {
      const base = { name: 'gemini', type: 'llm', adapter: 'gemini', model: 'm', cost: { tier: 'free' }, platformBilled: false };
      for (const outputLimits of [
        { perFeature: { summary: 8193 } },
        { perStep: { reduce: 8193 } },
        { perFeatureStep: { summary: { reduce: 9000 } } },
        { defaultMaxTokens: 8193 },
        { perStep: { unknown: 100 } },
      ]) expect(providerConfigSchema.safeParse({ ...base, outputLimits }).success, JSON.stringify(outputLimits)).toBe(false);
      expect(providerConfigSchema.safeParse({ ...base, outputLimits: { perFeature: { summary: 8192 }, perStep: { reduce: 8192 } } }).success).toBe(true);
    });
  });
});
