import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { effectiveOutputLimits, extractMeeting, meetingExtractionSchema, SUMMARY_OUTPUT_LIMITS, type ExtractionSegment } from '../src/index.js';
import { createRuleBasedLLM } from './mock-llm.js';

type Fixture = {
  name: string;
  title?: string;
  segments: ExtractionSegment[];
  golden: { decisions: string[]; draftTaskTitles: string[]; assigneeHints: string[]; flaggedTitles: string[]; minWindows?: number };
};

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);

describe.each(fixtures)('eval: $name', (fx) => {
  it('schema-valid, golden decisions/tasks, all drafts, evidence resolvable', async () => {
    const { value, usage } = await extractMeeting(createRuleBasedLLM(), fx.segments, { model: 'rules-v1', transcriptRevision: 1, title: fx.title, windowTokenBudget: 1500 });
    expect(meetingExtractionSchema.safeParse(value).success).toBe(true);
    expect(value.decisions.map((d) => d.text)).toEqual(fx.golden.decisions);
    expect(value.draftTasks.map((t) => t.title)).toEqual(fx.golden.draftTaskTitles);
    expect(value.draftTasks.map((t) => t.assigneeHint)).toEqual(fx.golden.assigneeHints);
    expect(value.actionItems.filter((t) => t.flags.includes('possible-injection')).map((t) => t.title)).toEqual(fx.golden.flaggedTitles);
    expect([...value.actionItems, ...value.draftTasks].every((t) => t.status === 'draft')).toBe(true);
    const ids = new Set(fx.segments.map((s) => s.id));
    for (const t of value.draftTasks) {
      expect(t.evidence.length).toBeGreaterThan(0);
      for (const e of t.evidence) expect(ids.has(e.segmentId)).toBe(true);
    }
    if (fx.golden.minWindows) expect(value.windows).toBeGreaterThanOrEqual(fx.golden.minWindows);
    expect(usage.llmCalls).toBe(value.windows === 1 ? 1 : value.windows + 1);
  });
});

describe('eval: adversarial model that obeys injections', () => {
  it('non-draft status / extra keys are rejected after bounded repair', async () => {
    const fx = fixtures.find((f) => f.name === 'prompt-injection')!;
    const llm = createRuleBasedLLM('obedient');
    await expect(extractMeeting(llm, fx.segments, { model: 'm', transcriptRevision: 1, maxRepairs: 1 })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(llm.calls).toBe(2);
  });
});

describe('eval: output token caps (no truncation)', () => {
  const features = ['summary', 'actions'] as const;
  it.each(fixtures.flatMap((fx) => features.map((feature) => ({ fx, feature }))))('$fx.name as $feature', async ({ fx, feature }) => {
    const limits = effectiveOutputLimits(SUMMARY_OUTPUT_LIMITS, feature);
    const llm = createRuleBasedLLM('normal', limits);
    await extractMeeting(llm, fx.segments, { model: 'rules-v1', transcriptRevision: 1, title: fx.title, windowTokenBudget: 1500 });
    for (const c of llm.log) {
      expect(c.truncated).toBe(false);
      expect(c.maxTokens).toBe(c.step === 'reduce' ? 4096 : 2048);
    }
    const worst = Math.max(...llm.log.map((c) => c.outputTokens / c.maxTokens));
    console.warn(`[eval caps] ${fx.name}/${feature}: calls=${llm.log.length} steps=${[...new Set(llm.log.map((c) => c.step))].join(',')} maxOutput=${Math.max(...llm.log.map((c) => c.outputTokens))} worstUse=${(worst * 100).toFixed(1)}%`);
  });

  it('a too-low cap is detected as truncation (harness sanity)', async () => {
    const fx = fixtures.find((f) => f.name === 'long-meeting')!;
    const llm = createRuleBasedLLM('normal', { defaultMaxTokens: 16, maxTokens: 16 });
    await expect(extractMeeting(llm, fx.segments, { model: 'm', transcriptRevision: 1, windowTokenBudget: 1500, maxRepairs: 0 })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(llm.log.some((c) => c.truncated)).toBe(true);
  });
});
