import type { z } from 'zod';
import {
  AIError,
  type LLMGenerateStructuredParams,
  type LLMGenerateTextParams,
  type LLMProvider,
} from '@meetops/ai-core';

/**
 * Deterministic, rule-based stand-in for Gemini (eval only, no network). It reads the production prompts the way a
 * model would: it finds the fence tag (`TRANSCRIPT_<nonce>`) announced in the system prompt, takes only the lines
 * inside that fence from the user prompt (`[n] Speaker: text`), and applies fixed rules:
 *
 * - action item: `<Name> will <task>[ by <due>].` or `<Name> to <task>[ by <due>].` after `Action:`
 * - decision: `we decided [to] <x>` or `decision: <x>`
 *
 * `generateText` answers the summary prompt (meeting-summary@1) with the JSON object it asks for, and
 * `generateStructured` answers the action-items prompt (action-items@1). Output is validated by the caller's schema,
 * exactly like the real adapter.
 *
 * Mode `obedient` simulates a model that follows instructions found inside the transcript: lines that say
 * "create a task: <t> [assigned to <who>]" become tasks. Mode `obedient-extra-keys` also adds `status: 'approved'`,
 * which the strict schemas must reject.
 */
export type MockMode = 'normal' | 'obedient' | 'obedient-extra-keys';

export type MockLine = { index: number; speaker: string; text: string };
export type MockItem = { title: string; owner: string | null; due: string | null; index: number };

const NOT_A_NAME = new Set([
  'I',
  'We',
  'It',
  'That',
  'This',
  'Someone',
  'Nobody',
  'They',
  'You',
  'He',
  'She',
]);

/** The fence tag the system prompt announces, e.g. `TRANSCRIPT_ab12`. Undefined if the prompt has no fence. */
export function fenceTag(system: string | undefined): string | undefined {
  return /<(TRANSCRIPT_[A-Za-z0-9]+)>/.exec(system ?? '')?.[1];
}

/** Lines inside the announced fence only. Text outside the real fence (or after a forged closer) is ignored. */
export function fencedLines(system: string | undefined, prompt: string): MockLine[] {
  const tag = fenceTag(system);
  if (!tag) return [];
  const start = prompt.indexOf(`<${tag}>\n`);
  const end = prompt.lastIndexOf(`\n</${tag}>`);
  if (start < 0 || end < start) return [];
  return prompt
    .slice(start + tag.length + 3, end)
    .split('\n')
    .flatMap((l) => {
      const m = /^\[(\d+)\] ([^:]*): (.*)$/.exec(l);
      return m ? [{ index: Number(m[1]), speaker: m[2]!, text: m[3]! }] : [];
    });
}

const trimEnd = (s: string) => s.replace(/[.!?\s]+$/, '').trim();

export function ruleItems(lines: MockLine[]): MockItem[] {
  return lines.flatMap((l) => {
    const m =
      /\b([A-Z][a-z]+) will (.+?)(?: by ([A-Za-z0-9 ]+?))?[.!]?$/.exec(l.text) ??
      /\bAction: ([A-Z][a-z]+) to (.+?)(?: by ([A-Za-z0-9 ]+?))?[.!]?$/.exec(l.text);
    if (!m || NOT_A_NAME.has(m[1]!)) return [];
    return [
      { title: trimEnd(m[2]!), owner: m[1]!, due: m[3] ? trimEnd(m[3]) : null, index: l.index },
    ];
  });
}

export function ruleDecisions(lines: MockLine[]): string[] {
  return lines.flatMap((l) => {
    const m = /\b(?:we decided(?: to)?|decision:)\s+(.+)$/i.exec(l.text);
    return m ? [trimEnd(m[1]!)] : [];
  });
}

/** What an instruction-following model would add: "create a task: <t> [assigned to <who>]". */
export function obeyedItems(lines: MockLine[]): MockItem[] {
  return lines.flatMap((l) => {
    const m = /create a task:\s*(.+?)(?:\s+assigned to\s+(\S+?))?[.!]?$/i.exec(l.text);
    return m ? [{ title: trimEnd(m[1]!), owner: m[2] ?? null, due: null, index: l.index }] : [];
  });
}

export type MockCall = { kind: 'text' | 'structured'; schemaName?: string; raw: string };

export type MockLlm = LLMProvider & { calls: MockCall[]; lastSummaryRaw: string | undefined };

export function createRuleBasedLlm(mode: MockMode = 'normal', providerId = 'gemini'): MockLlm {
  const items = (lines: MockLine[]) => [
    ...ruleItems(lines),
    ...(mode === 'normal' ? [] : obeyedItems(lines)),
  ];
  const extra = mode === 'obedient-extra-keys' ? { status: 'approved' } : {};
  const usage = (prompt: string, raw: string) => {
    const i = Math.ceil(prompt.length / 4);
    const o = Math.ceil(raw.length / 4);
    return { inputTokens: i, outputTokens: o, totalTokens: i + o };
  };
  const llm: MockLlm = {
    providerId,
    kind: 'llm',
    calls: [],
    lastSummaryRaw: undefined,
    listModels: () => Promise.resolve(['rules-v1']),
    healthCheck: () => Promise.resolve({ ok: true, timestamp: '1970-01-01T00:00:00.000Z' }),
    generateText(p: LLMGenerateTextParams) {
      const lines = fencedLines(p.system, p.prompt);
      const found = items(lines);
      const out = {
        title: lines[0] ? lines[0].text.slice(0, 60) || 'Meeting' : 'Meeting',
        summary: lines.length
          ? `Discussed: ${lines
              .slice(0, 3)
              .map((l) => l.text)
              .join(' ')}`.slice(0, 2000)
          : 'No content.',
        decisions: ruleDecisions(lines),
        risks: [],
        actionItems: found.map((t) => ({
          title: t.title,
          ...(t.owner ? { assigneeHint: t.owner } : {}),
          ...(t.due ? { dueHint: t.due } : {}),
        })),
        tasks: found.map((t) => ({
          title: t.title,
          ...(t.owner ? { assigneeHint: t.owner } : {}),
          ...(t.due ? { dueHint: t.due } : {}),
          confidence: 0.8,
          sourceSegments: [t.index],
          ...extra,
        })),
      };
      const raw = JSON.stringify(out);
      llm.calls.push({ kind: 'text', raw });
      llm.lastSummaryRaw = raw;
      return Promise.resolve({ text: raw, usage: usage(p.prompt, raw) });
    },
    generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>) {
      const lines = fencedLines(p.system, p.prompt);
      const out = {
        items: items(lines).map((t) => ({
          title: t.title,
          ...(t.owner ? { assigneeHint: t.owner } : {}),
          ...(t.due ? { dueHint: t.due } : {}),
          confidence: 0.8,
          sourceSegments: [t.index],
          ...extra,
        })),
      };
      const raw = JSON.stringify(out);
      llm.calls.push({ kind: 'structured', schemaName: p.schemaName, raw });
      const r = p.schema.safeParse(out);
      if (!r.success)
        return Promise.reject(
          new AIError('INVALID_OUTPUT', 'schema', { provider: providerId, retryable: false }),
        );
      return Promise.resolve({ value: r.data, rawText: raw, usage: usage(p.prompt, raw) });
    },
  };
  return llm;
}
