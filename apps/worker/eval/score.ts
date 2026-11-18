/** Scoring for the worker eval: action-item precision/recall (text + owner + due), decision precision/recall. */

export type GoldenItem = { title: string; owner: string | null; due: string | null };
export type PredictedItem = { title: string; owner: string | null; due: string | null };

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'on', 'by', 'with', 'our', 'up']);

/**
 * Unicode-aware word tokens after NFC + lowercase.
 * `\\p{M}` is included so Devanagari matras stay attached to the letter (`[\\p{L}\\p{N}]+` alone would split
 * मीटिंग into म, ट, ग).
 */
export function tokens(s: string): Set<string> {
  const parts =
    s
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return new Set(parts.filter((t) => t && !STOP.has(t)));
}

/**
 * Token Jaccard similarity after normalisation (stop words dropped).
 * Empty vs non-empty is 0. Two empty token sets are also 0 — they are not a match.
 * (A fixture that expects no items is scored at the list level, not here.)
 */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export const TEXT_MATCH_THRESHOLD = 0.6;

const normField = (v: string | null | undefined) =>
  (v ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

export type ItemScore = {
  predicted: number;
  golden: number;
  /** Pairs whose text matches (greedy one-to-one, best similarity first). */
  textMatched: number;
  /** Text matches whose owner AND due also match: the strict true positives. */
  strictMatched: number;
  textPrecision: number;
  textRecall: number;
  precision: number;
  recall: number;
  ownerAccuracy: number;
  dueAccuracy: number;
  unmatchedPredicted: string[];
  missedGolden: string[];
};

/** 0/0 is 1 only for an empty-vs-empty list (fixture expects no items and none were predicted). */
const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

export function scoreItems(pred: PredictedItem[], gold: GoldenItem[]): ItemScore {
  const pairs: Array<{ p: number; g: number; s: number }> = [];
  pred.forEach((p, i) =>
    gold.forEach((g, j) => {
      const s = similarity(p.title, g.title);
      if (s >= TEXT_MATCH_THRESHOLD) pairs.push({ p: i, g: j, s });
    }),
  );
  pairs.sort((a, b) => b.s - a.s);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  let owner = 0;
  let due = 0;
  let strict = 0;
  for (const { p, g } of pairs) {
    if (usedP.has(p) || usedG.has(g)) continue;
    usedP.add(p);
    usedG.add(g);
    const o = normField(pred[p]!.owner) === normField(gold[g]!.owner);
    const d = normField(pred[p]!.due) === normField(gold[g]!.due);
    if (o) owner++;
    if (d) due++;
    if (o && d) strict++;
  }
  const matched = usedP.size;
  return {
    predicted: pred.length,
    golden: gold.length,
    textMatched: matched,
    strictMatched: strict,
    textPrecision: ratio(matched, pred.length),
    textRecall: ratio(matched, gold.length),
    precision: ratio(strict, pred.length),
    recall: ratio(strict, gold.length),
    ownerAccuracy: ratio(owner, matched),
    dueAccuracy: ratio(due, matched),
    unmatchedPredicted: pred.filter((_, i) => !usedP.has(i)).map((p) => p.title),
    missedGolden: gold.filter((_, j) => !usedG.has(j)).map((g) => g.title),
  };
}

export type DecisionScore = {
  predicted: number;
  golden: number;
  matched: number;
  precision: number;
  recall: number;
  missed: string[];
  extra: string[];
};

/** One-to-one decision matches. Precision drops when the model hallucinates extra decisions. */
export function scoreDecisions(pred: string[], gold: string[]): DecisionScore {
  const used = new Set<number>();
  const missed: string[] = [];
  for (const g of gold) {
    let best = -1;
    let bestS = 0;
    pred.forEach((p, i) => {
      const s = similarity(p, g);
      if (!used.has(i) && s >= TEXT_MATCH_THRESHOLD && s > bestS) {
        best = i;
        bestS = s;
      }
    });
    if (best >= 0) used.add(best);
    else missed.push(g);
  }
  const matched = used.size;
  return {
    predicted: pred.length,
    golden: gold.length,
    matched,
    precision: ratio(matched, pred.length),
    recall: ratio(matched, gold.length),
    missed,
    extra: pred.filter((_, i) => !used.has(i)),
  };
}

/** @deprecated Use scoreDecisions (also reports precision). Kept for call-site clarity in older tests. */
export function decisionRecall(
  pred: string[],
  gold: string[],
): { recall: number; missed: string[] } {
  const s = scoreDecisions(pred, gold);
  return { recall: s.recall, missed: s.missed };
}
