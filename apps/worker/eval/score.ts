/** Scoring for the worker eval: action-item precision/recall (text + owner + due), decision recall. */

export type GoldenItem = { title: string; owner: string | null; due: string | null };
export type PredictedItem = { title: string; owner: string | null; due: string | null };

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'on', 'by', 'with', 'our', 'up']);

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  );
}

/** Token Jaccard similarity of two strings after normalisation (stop words dropped). */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export const TEXT_MATCH_THRESHOLD = 0.6;

const normField = (v: string | null | undefined) =>
  (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

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

/** Share of golden decisions with a matching predicted decision (one-to-one). */
export function decisionRecall(
  pred: string[],
  gold: string[],
): { recall: number; missed: string[] } {
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
  return { recall: ratio(gold.length - missed.length, gold.length), missed };
}
