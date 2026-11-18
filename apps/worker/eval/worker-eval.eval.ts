import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runFixture, type EvalFixture } from './harness.js';
import { findRepoRoot, loadFixtureFile, loadFixtures, resolveEvalDataDir } from './load.js';
import { createRuleBasedLlm, fencedLines } from './mock-llm.js';
import {
  TEXT_MATCH_THRESHOLD,
  scoreDecisions,
  scoreItems,
  similarity,
  tokens,
  type ItemScore,
} from './score.js';

const fixtures: EvalFixture[] = loadFixtures();

type Row = {
  fixture: string;
  mode: string;
  score: ItemScore;
  decisionPrecision: number;
  decisionRecall: number;
  schema: boolean;
};
const rows: Row[] = [];
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

afterAll(() => {
  // File names and scores only — never transcript text, goldens, or missed/extra titles.
  for (const r of rows)
    console.warn(
      `[worker eval] ${r.fixture}/${r.mode}: tasks P=${pct(r.score.precision)} R=${pct(r.score.recall)} ` +
        `(text P=${pct(r.score.textPrecision)} R=${pct(r.score.textRecall)}, owner=${pct(r.score.ownerAccuracy)}, ` +
        `due=${pct(r.score.dueAccuracy)}) decisions P=${pct(r.decisionPrecision)} R=${pct(r.decisionRecall)} ` +
        `schema=${r.schema ? 'ok' : 'INVALID'} missed=${r.score.missedGolden.length} extra=${r.score.unmatchedPredicted.length}`,
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
    const dec = scoreDecisions(run.summary?.content.decisions ?? [], fx.golden.decisions);
    rows.push({
      fixture: fx.name,
      mode: 'normal',
      score,
      decisionPrecision: dec.precision,
      decisionRecall: dec.recall,
      schema: run.reportContentValid,
    });
    const th = fx.golden.thresholds ?? {};
    expect(score.precision).toBeGreaterThanOrEqual(th.precision ?? 1);
    expect(score.recall).toBeGreaterThanOrEqual(th.recall ?? 1);
    expect(dec.precision).toBeGreaterThanOrEqual(th.decisionPrecision ?? 1);
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
    const dec = scoreDecisions(run.summary?.content.decisions ?? [], fx.golden.decisions);
    rows.push({
      fixture: fx.name,
      mode: 'obedient',
      score,
      decisionPrecision: dec.precision,
      decisionRecall: dec.recall,
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
  });

  it('scorer: Unicode tokens, Devanagari and romanised Hinglish titles', () => {
    expect(tokens('मीटिंग नोट्स भेजो')).toEqual(new Set(['मीटिंग', 'नोट्स', 'भेजो']));
    expect(tokens('Standup notes bhejo!')).toEqual(new Set(['standup', 'notes', 'bhejo']));
    expect(similarity('मीटिंग नोट्स भेजो', 'मीटिंग नोट्स भेजो')).toBe(1);
    expect(similarity('standup notes bhejo', 'Standup notes bhejo!')).toBe(1);
    // Two different Devanagari titles must not collapse to empty and score as a perfect match.
    const twoHindi = similarity('मीटिंग नोट्स भेजो', 'क्लाइंट लिंक भेजो');
    expect(twoHindi).toBeLessThan(TEXT_MATCH_THRESHOLD);
    expect(twoHindi).toBeLessThan(1);
    // Hindi-script golden vs a wrong English prediction must not match.
    expect(similarity('मीटिंग नोट्स भेजो', 'send the meeting notes')).toBe(0);
    const hindiVsEnglish = scoreItems(
      [{ title: 'send the meeting notes', owner: 'Zoya', due: 'Friday' }],
      [{ title: 'मीटिंग नोट्स भेजो', owner: 'Zoya', due: 'Friday' }],
    );
    expect(hindiVsEnglish).toMatchObject({ textMatched: 0, precision: 0, recall: 0 });
    // Empty vs non-empty is 0; empty vs empty is also 0 at the string level.
    expect(similarity('', 'मीटिंग नोट्स भेजो')).toBe(0);
    expect(similarity('notes', '')).toBe(0);
    expect(similarity('', '')).toBe(0);
    expect(similarity('   ', '!!!')).toBe(0);
    // Empty-vs-empty is a match only when the fixture expects no items (empty lists).
    expect(scoreItems([], [])).toMatchObject({ precision: 1, recall: 1, textMatched: 0 });
    expect(
      scoreItems([{ title: '', owner: null, due: null }], [{ title: '', owner: null, due: null }]),
    ).toMatchObject({
      textMatched: 0,
      precision: 0,
      recall: 0,
    });
  });

  it('scorer: hallucinated extra decisions fail precision, not just recall', () => {
    const gold = ['ship v2 on Friday', 'hire two engineers'];
    expect(scoreDecisions(['ship v2 Friday'], gold)).toEqual({
      predicted: 1,
      golden: 2,
      matched: 1,
      precision: 1,
      recall: 0.5,
      missed: ['hire two engineers'],
      extra: [],
    });
    expect(
      scoreDecisions(['ship v2 Friday', 'hire two engineers', 'buy a yacht'], gold),
    ).toMatchObject({
      matched: 2,
      precision: 2 / 3,
      recall: 1,
      missed: [],
      extra: ['buy a yacht'],
    });
    expect(scoreDecisions([], [])).toMatchObject({
      precision: 1,
      recall: 1,
      missed: [],
      extra: [],
    });
    expect(scoreDecisions(['unexpected decision'], [])).toMatchObject({
      precision: 0,
      recall: 1,
      extra: ['unexpected decision'],
    });
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

describe('worker eval: fixture loading', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);

  it('schema-validates bundled fixtures and names the file on error', () => {
    const ok = loadFixtureFile(join(here, 'fixtures', 'standup.json'));
    expect(ok.name).toBe('standup');
    const dir = mkdtempSync(join(tmpdir(), 'meetops-eval-bad-'));
    const bad = join(dir, 'broken.json');
    writeFileSync(bad, '{"name":"broken"}');
    expect(() => loadFixtureFile(bad)).toThrow(/Invalid eval fixture .*broken\.json/);
  });

  it('EVAL_DATA_DIR refuses a path inside the repo and a relative path', () => {
    expect(() => resolveEvalDataDir(here, repoRoot)).toThrow(/outside the repo root/);
    expect(() => resolveEvalDataDir(repoRoot, repoRoot)).toThrow(/outside the repo root/);
    expect(() => resolveEvalDataDir('eval/fixtures', repoRoot)).toThrow(/absolute path/);
  });

  it('EVAL_DATA_DIR loads extra fixtures from an outside directory and is refused in CI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meetops-eval-data-'));
    const src = loadFixtureFile(join(here, 'fixtures', 'noisy-no-actions.json'));
    writeFileSync(
      join(dir, 'external.json'),
      JSON.stringify({ ...src, name: 'external-consented-standin' }),
    );
    expect(resolveEvalDataDir(dir, repoRoot)).toBeTruthy();
    const loaded = loadFixtures({
      env: { EVAL_DATA_DIR: dir },
      bundledDir: join(here, 'fixtures'),
      repoRoot,
    });
    expect(loaded.some((f) => f.name === 'external-consented-standin')).toBe(true);
    expect(loaded.some((f) => f.name === 'standup')).toBe(true);
    expect(() =>
      loadFixtures({
        env: { EVAL_DATA_DIR: dir, CI: 'true' },
        bundledDir: join(here, 'fixtures'),
        repoRoot,
      }),
    ).toThrow(/must not be set in CI/);
  });
});
