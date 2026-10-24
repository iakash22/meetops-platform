import type { TranscriptSegment } from '../types.js';

/** One STT result for one audio chunk, with chunk-relative timestamps. */
export type ChunkTranscript = {
  chunkIndex: number;
  /** Absolute start of the chunk within the recording (seconds). */
  startSec: number;
  durationSec: number;
  /** Seconds this chunk overlaps the previous chunk (0 for the first). */
  overlapSec: number;
  segments: TranscriptSegment[];
  provider: string;
  model: string;
  language?: string | undefined;
  receivedAt: string;
};

export type MergedSegment = {
  /** Stable id: "c<chunk>-s<n>" (n = index within that chunk's provider output). */
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Normalized, recording-wide label ("S1", "S2", ...). Provider labels never leak across chunks. */
  speaker?: string | undefined;
  confidence?: number | undefined;
  chunkIndex: number;
};

export type MergedTranscript = {
  segments: MergedSegment[];
  text: string;
  chunkIndexes: number[];
  /** Gaps in the chunk sequence (e.g. chunk 2 not received yet). */
  missingChunks: number[];
  complete: boolean;
  durationSec: number;
  /** chunkIndex -> providerLabel -> normalized label. */
  speakerMap: Record<number, Record<string, string>>;
};

/** Keep one result per chunkIndex: the earliest received (duplicates/redeliveries are ignored). */
export function dedupeChunks(chunks: ChunkTranscript[]): ChunkTranscript[] {
  const m = new Map<number, ChunkTranscript>();
  for (const c of chunks) {
    const prev = m.get(c.chunkIndex);
    if (!prev || c.receivedAt < prev.receivedAt) m.set(c.chunkIndex, c);
  }
  return [...m.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

const overlapLen = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Merge chunk transcripts into one recording-level transcript.
 * - Out-of-order and duplicate chunks: sorted by index, first-received wins.
 * - Time offsets: segment times are shifted by the chunk's absolute start.
 * - Overlap: the shared region [start_i, start_i + overlap_i) is split at its midpoint; each segment is kept only in the
 *   chunk whose window contains the segment's midpoint, so overlapping speech is not duplicated.
 * - Speakers: a chunk's provider labels are mapped to previous labels by time-overlap of their speech inside the overlap
 *   region with the previous chunk; unmatched labels get a new recording-wide label.
 */
export function mergeChunkTranscripts(input: ChunkTranscript[], expectedChunkCount?: number): MergedTranscript {
  const chunks = dedupeChunks(input);
  const abs = chunks.map((c) => ({
    c,
    segs: c.segments.map((s, n) => ({ ...s, n, a0: c.startSec + s.startSec, a1: c.startSec + s.endSec })),
  }));
  const speakerMap: Record<number, Record<string, string>> = {};
  let nextSpeaker = 1;
  const out: MergedSegment[] = [];

  abs.forEach(({ c, segs }, i) => {
    const prev = i > 0 ? abs[i - 1] : undefined;
    const contiguous = prev !== undefined && prev.c.chunkIndex === c.chunkIndex - 1;
    const map: Record<string, string> = {};
    // speaker normalization via overlap region
    if (contiguous && prev && c.overlapSec > 0) {
      const ov0 = c.startSec;
      const ov1 = c.startSec + c.overlapSec;
      const prevMap = speakerMap[prev.c.chunkIndex] ?? {};
      const labels = [...new Set(segs.map((s) => s.speaker).filter((x): x is string => !!x))];
      const used = new Set<string>();
      for (const label of labels) {
        const score = new Map<string, number>();
        for (const s of segs.filter((x) => x.speaker === label)) {
          for (const p of prev.segs) {
            if (!p.speaker) continue;
            const t = overlapLen(s.a0, s.a1, p.a0, p.a1) * (overlapLen(s.a0, s.a1, ov0, ov1) > 0 ? 1 : 0);
            const g = prevMap[p.speaker];
            if (t > 0 && g) score.set(g, (score.get(g) ?? 0) + t);
          }
        }
        const best = [...score.entries()].filter(([g]) => !used.has(g)).sort((a, b) => b[1] - a[1])[0];
        if (best) {
          map[label] = best[0];
          used.add(best[0]);
        }
      }
    }
    for (const s of segs) if (s.speaker && !map[s.speaker]) map[s.speaker] = `S${nextSpeaker++}`;
    speakerMap[c.chunkIndex] = map;

    const next = abs[i + 1];
    const lo = contiguous ? c.startSec + c.overlapSec / 2 : -Infinity;
    const hi = next && next.c.chunkIndex === c.chunkIndex + 1 ? next.c.startSec + next.c.overlapSec / 2 : Infinity;
    for (const s of segs) {
      const mid = (s.a0 + s.a1) / 2;
      if (mid < lo || mid >= hi) continue;
      const text = s.text.trim();
      if (!text) continue;
      out.push({
        id: `c${c.chunkIndex}-s${s.n}`,
        startSec: round(s.a0),
        endSec: round(s.a1),
        text,
        speaker: s.speaker ? map[s.speaker] : undefined,
        confidence: s.confidence,
        chunkIndex: c.chunkIndex,
      });
    }
  });

  out.sort((a, b) => a.startSec - b.startSec || a.chunkIndex - b.chunkIndex);
  const idx = chunks.map((c) => c.chunkIndex);
  const max = Math.max(expectedChunkCount !== undefined ? expectedChunkCount - 1 : -1, ...idx, -1);
  const missingChunks: number[] = [];
  for (let k = 0; k <= max; k++) if (!idx.includes(k)) missingChunks.push(k);
  const last = chunks[chunks.length - 1];
  return {
    segments: out,
    text: out.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n'),
    chunkIndexes: idx,
    missingChunks,
    complete: missingChunks.length === 0 && (expectedChunkCount === undefined || idx.length === expectedChunkCount),
    durationSec: last ? round(last.startSec + last.durationSec) : 0,
    speakerMap,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
