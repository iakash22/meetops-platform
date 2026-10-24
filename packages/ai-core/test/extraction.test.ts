import { describe, it, expect } from 'vitest';
import { chunkSegmentsByTokens, extractMeeting, runExtractionJob, sanitizeHint, draftTaskSchema, type ExtractionSegment } from '../src/index.js';
import { createRuleBasedLLM } from '../eval/mock-llm.js';
import { llmCfg, setup } from './helpers.js';

const seg = (i: number, text: string): ExtractionSegment => ({ id: `c0-s${i}`, startSec: i * 5, endSec: i * 5 + 5, speaker: 'S1', text });

describe('token-budgeted chunking', () => {
  it('respects budget, never splits segments, supports overlap', () => {
    const segs = Array.from({ length: 20 }, (_, i) => seg(i, 'x'.repeat(200)));
    const w = chunkSegmentsByTokens(segs, 200);
    expect(w.length).toBeGreaterThan(5);
    expect(w.flat()).toHaveLength(20);
    const o = chunkSegmentsByTokens(segs, 200, 1);
    expect(o[1]?.[0]?.id).toBe(o[0]?.[o[0].length - 1]?.id);
  });
});

describe('extraction', () => {
  it('drops unknown evidence ids and flags tasks without evidence', async () => {
    const llm = createRuleBasedLLM();
    const orig = llm.generateStructured.bind(llm);
    llm.generateStructured = (async (p: Parameters<typeof orig>[0]) => {
      const r = await orig(p);
      const v = r.value as { actionItems?: Array<{ evidenceSegmentIds: string[] }> };
      v.actionItems?.forEach((a) => (a.evidenceSegmentIds = ['bogus']));
      return r;
    }) as typeof llm.generateStructured;
    const { value } = await extractMeeting(llm, [seg(0, 'Ana will do it.')], { model: 'm', transcriptRevision: 2 });
    expect(value.actionItems[0]?.evidence).toEqual([]);
    expect(value.actionItems[0]?.flags).toContain('no-evidence');
    expect(value.draftTasks).toEqual([]);
    expect(value.transcriptRevision).toBe(2);
  });
  it('assigneeHint is sanitized text, schema forbids identity fields and non-draft', () => {
    expect(sanitizeHint('  <b>Bob</b>\u0007 ')).toBe('bBob/b');
    const base = { title: 't', description: '', status: 'draft', assigneeHint: 'Bob', dueHint: null, evidence: [], flags: [] };
    expect(draftTaskSchema.safeParse(base).success).toBe(true);
    expect(draftTaskSchema.safeParse({ ...base, assigneeUserId: 'u1' }).success).toBe(false);
    expect(draftTaskSchema.safeParse({ ...base, status: 'open' }).success).toBe(false);
  });
  it('runExtractionJob via executor: metadata + idempotent per transcript revision', async () => {
    const llm = createRuleBasedLLM();
    const { executor } = await setup({ providers: { gemini: llm }, configs: [llmCfg('gemini')] });
    const payload = { jobVersion: 1 as const, organizationId: '00000000-0000-4000-8000-0000000000c1', idempotencyKey: '50000000-0000-4000-8000-000000000009', kind: 'extract_tasks' as const, meetingId: '10000000-0000-4000-8000-000000000001', transcriptId: '20000000-0000-4000-8000-000000000001', modelRouteId: 'gemini:gemini-2.5-flash-lite', promptVersion: 'x' };
    const tr = { revision: 3, segments: [seg(0, 'Ana will write docs.')] };
    const a = await runExtractionJob(executor, payload, tr);
    const b = await runExtractionJob(executor, payload, tr);
    expect(llm.calls).toBe(1);
    expect(a.status === 'succeeded' && a.meta).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-lite', transcriptRevision: 3, promptVersion: 'meeting-map@1+meeting-reduce@1' });
    expect(b.status === 'succeeded' && b.meta.cached).toBe(true);
    await runExtractionJob(executor, payload, { ...tr, revision: 4 });
    expect(llm.calls).toBe(2);
  });
});
