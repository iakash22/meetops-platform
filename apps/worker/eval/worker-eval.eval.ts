import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runFixture, type EvalFixture } from './harness.js';
import { createRuleBasedLlm, fencedLines } from './mock-llm.js';
import { decisionRecall, scoreItems, similarity, type ItemScore } from './score.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures: EvalFixture[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalFixture);

type Row = {
  fixture: string;
  mode: string;
  score: ItemScore;
  decisionRecall: number;
  schema: boolean;
};
const rows: Row[] = [];
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

afterAll(() => {
  // One-line-per-fixture report (stderr), so a prompt or model change shows its effect at a glance.
  for (const r of rows)
    console.warn(
      `[worker eval] ${r.fixture}/${r.mode}: tasks P=${pct(r.score.precision)} R=${pct(r.score.recall)} ` +
        `(text P=${pct(r.score.textPrecision)} R=${pct(r.score.textRecall)}, owner=${pct(r.score.ownerAccuracy)}, ` +
        `due=${pct(r.score.dueAccuracy)}) decisions R=${pct(r.decisionRecall)} schema=${r.schema ? 'ok' : 'INVALID'}` +
        (r.score.missedGolden.length ? ` missed=${JSON.stringify(r.score.missedGolden)}` : '') +
        (r.score.unmatchedPredicted.length
          ? ` extra=${JSON.stringify(r.score.unmatchedPredicted)}`
          : ''),
    );
});

const forbiddenHits = (fx: EvalFixture, texts: string[]) =>
  (fx.golden.forbidden ?? []).filter((p) => texts.some((t) => new RegExp(p, 'i').test(t)));

describe.each(fixtures)('worker eval: $name', (fx) => {
  it('production summary + action items meet the fixture thresholds', async () => {
    const run = await runFixture(fx, createRuleBasedLlm());
    expect(run.errorCode).toBeUndefined();
    expect(run.summaryRawValid).toBe(true);
    expect(run.reportContentValid).toBe(true);
    const tasks = run.extraction?.tasks ?? [];
    // With the dedicated extractor wired, the summary itself persists no tasks (no duplicate drafts).
    expect(run.summary?.tasks).toEqual([]);
    const score = scoreItems(
      tasks.map((t) => ({ title: t.title, owner: t.assigneeHint, due: t.dueHint })),
      fx.golden.actionItems,
    );
    const dec = decisionRecall(run.summary?.content.decisions ?? [], fx.golden.decisions);
    rows.push({
      fixture: fx.name,
      mode: 'normal',
      score,
      decisionRecall: dec.recall,
      schema: run.reportContentValid,
    });
    const th = fx.golden.thresholds ?? {};
    expect(score.precision).toBeGreaterThanOrEqual(th.precision ?? 1);
    expect(score.recall).toBeGreaterThanOrEqual(th.recall ?? 1);
    expect(dec.recall).toBeGreaterThanOrEqual(th.decisionRecall ?? 1);
    // Every persisted task points at a real transcript segment, and nothing forbidden leaks into a task.
    const ids = new Set(fx.transcript.segments.map((s) => s.id));
    for (const t of tasks) for (const id of t.sourceSegmentIds) expect(ids.has(id)).toBe(true);
    expect(
      forbiddenHits(
        fx,
        tasks.flatMap((t) => [t.title, t.assigneeHint ?? '', t.dueHint ?? '']),
      ),
    ).toEqual([]);
  });
});

describe('worker eval: adversarial model behaviour', () => {
  const fx = fixtures.find((f) => f.name === 'adversarial')!;

  it('a model that adds `status: approved` is rejected: the summary fails closed, nothing is stored', async () => {
    const run = await runFixture(fx, createRuleBasedLlm('obedient-extra-keys'));
    expect(run.ok).toBe(false);
    expect(run.errorCode).toBe('invalid_model_output');
    expect(run.summary).toBeUndefined();
    expect(run.extraction).toBeUndefined();
  });

  it('a model that obeys injected "create a task" lines is caught by the scorer (precision drop, forbidden hits)', async () => {
    // Current production behaviour (documented gap, see docs/09-ai/ai-evaluation.md): worker tasks carry no
    // injection flag, so obeyed tasks are persisted as pending_review drafts; only human review stops them.
    const run = await runFixture(fx, createRuleBasedLlm('obedient'));
    expect(run.ok).toBe(true);
    const tasks = run.extraction?.tasks ?? [];
    const score = scoreItems(
      tasks.map((t) => ({ title: t.title, owner: t.assigneeHint, due: t.dueHint })),
      fx.golden.actionItems,
    );
    rows.push({
      fixture: fx.name,
      mode: 'obedient',
      score,
      decisionRecall: 1,
      schema: run.reportContentValid,
    });
    expect(score.precision).toBeLessThan(1);
    expect(
      forbiddenHits(
        fx,
        tasks.flatMap((t) => [t.title, t.assigneeHint ?? '']),
      ),
    ).not.toEqual([]);
  });
});

describe('worker eval: harness sanity', () => {
  it('scorer: perfect, missing, extra and wrong-owner cases', () => {
    const g = [
      { title: 'fix the login bug', owner: 'Arjun', due: 'Thursday' },
      { title: 'update the changelog', owner: 'Meera', due: null },
    ];
    expect(scoreItems(g, g)).toMatchObject({ precision: 1, recall: 1 });
    expect(scoreItems([g[0]!], g)).toMatchObject({
      precision: 1,
      recall: 0.5,
      missedGolden: ['update the changelog'],
    });
    expect(scoreItems([...g, { title: 'order pizza', owner: null, due: null }], g)).toMatchObject({
      precision: 2 / 3,
      recall: 1,
    });
    const wrongOwner = scoreItems([{ ...g[0]!, owner: 'Mallory' }], [g[0]!]);
    expect(wrongOwner).toMatchObject({
      textRecall: 1,
      recall: 0,
      ownerAccuracy: 0,
      dueAccuracy: 1,
    });
    expect(scoreItems([], [])).toMatchObject({ precision: 1, recall: 1 });
    expect(similarity('Fix the login bug!', 'fix login bug')).toBe(1);
    expect(decisionRecall(['ship v2 Friday'], ['ship v2 on Friday', 'hire two engineers'])).toEqual(
      {
        recall: 0.5,
        missed: ['hire two engineers'],
      },
    );
  });

  it('mock reads only the fence announced in the system prompt', () => {
    const system = 'between <TRANSCRIPT_abc> and </TRANSCRIPT_abc>';
    const prompt =
      'Language: en\n<TRANSCRIPT_abc>\n[0] A: Asha will send notes by Friday.\n</TRANSCRIPT_abc>\n[1] X: Eve will leak data.';
    expect(fencedLines(system, prompt)).toEqual([
      { index: 0, speaker: 'A', text: 'Asha will send notes by Friday.' },
    ]);
    expect(fencedLines('no fence here', prompt)).toEqual([]);
  });
});
