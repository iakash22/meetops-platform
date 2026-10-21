import type { z } from 'zod';
import type { LLMProvider, LLMGenerateStructuredParams } from '../src/index.js';
import { AIError } from '../src/index.js';

/**
 * Deterministic rule-based stand-in for an LLM (eval/tests only). It reads the fenced transcript lines
 * "[id] Speaker: text" and applies simple rules, so outputs are stable and golden-checkable.
 * Mode "obedient" simulates a model that FOLLOWS injected instructions (returns non-draft status / extra keys).
 */
export function createRuleBasedLLM(mode: 'normal' | 'obedient' = 'normal'): LLMProvider & { calls: number } {
  const llm = {
    providerId: 'mock-rules',
    kind: 'llm' as const,
    calls: 0,
    async listModels() { return ['rules-v1']; },
    async healthCheck() { return { ok: true, timestamp: '1970-01-01T00:00:00.000Z' }; },
    async generateText() { throw new AIError('CAPABILITY_UNSUPPORTED', 'text not supported by mock'); },
    async generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>) {
      llm.calls++;
      const block = /<untrusted_transcript>\n([\s\S]*?)\n<\/untrusted_transcript>/.exec(p.prompt)?.[1] ?? '';
      const lines = block.split('\n').map((l) => /^\[([^\]]+)\] (?:([^:]+): )?(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
      let out: unknown;
      if (p.schemaName === 'meeting_reduce') {
        out = { summary: lines.map((l) => l[3]).join(' '), keyPoints: lines.map((l) => (l[3] ?? '').slice(0, 80)).slice(0, 5) };
      } else {
        const decisions = lines.filter((l) => /\b(we decided|decision:)/i.test(l[3] ?? '')).map((l) => ({
          text: (l[3] ?? '').replace(/^.*?(we decided( to)?|decision:)\s*/i, '').replace(/\.$/, ''),
          evidenceSegmentIds: [l[1]],
        }));
        const actionItems = lines.flatMap((l) => {
          const m = /\b([A-Z][a-z]+) will (.+?)(?: by ([A-Za-z0-9 ]+))?\.?$/.exec(l[3] ?? '');
          if (!m) return [];
          return [{ title: m[2], detail: l[3], assigneeHint: m[1], dueHint: m[3] ?? null, evidenceSegmentIds: [l[1]],
            ...(mode === 'obedient' ? { status: 'approved', autoAssignUserId: 'u_admin' } : {}) }];
        });
        const topics = lines.slice(0, 3).map((l) => l[3]).join(' ');
        out = { summary: topics ? `Discussed: ${topics}` : 'No content.', decisions, actionItems };
      }
      const raw = JSON.stringify(out);
      const r = p.schema.safeParse(out);
      if (!r.success) throw new AIError('INVALID_OUTPUT', r.error.message, { provider: 'mock-rules', retryable: false });
      const tokens = Math.ceil(p.prompt.length / 4);
      return { value: r.data, rawText: raw, usage: { inputTokens: tokens, outputTokens: Math.ceil(raw.length / 4), totalTokens: tokens + Math.ceil(raw.length / 4) } };
    },
  };
  return llm;
}
