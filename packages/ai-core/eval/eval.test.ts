import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { extractMeeting, meetingExtractionSchema, type ExtractionSegment } from '../src/index.js';
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
