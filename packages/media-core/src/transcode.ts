import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { probeMedia } from './probe.js';
import { resolveTools, runProcess, type MediaToolsOptions } from './run.js';

export type NormalizeOptions = MediaToolsOptions & {
  sampleRate?: number;
  channels?: number;
};

/** ffmpeg argv to normalize any input to PCM s16le WAV (default 16 kHz mono). */
export function buildNormalizeArgs(input: string, output: string, o: { sampleRate?: number; channels?: number } = {}): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vn', '-sn', '-dn',
    '-ac', String(o.channels ?? 1),
    '-ar', String(o.sampleRate ?? 16000),
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    output
  ];
}

export async function normalizeToWav(input: string, output: string, opts: NormalizeOptions = {}): Promise<string> {
  const t = resolveTools(opts);
  await mkdir(path.dirname(output), { recursive: true });
  await runProcess(t.ffmpeg, buildNormalizeArgs(input, output, opts), { timeoutMs: t.timeoutMs, signal: opts.signal });
  return output;
}

export type ChunkOptions = MediaToolsOptions & {
  /** Segment length in seconds (default 600). */
  segmentSeconds?: number;
  /** Filename prefix (default "chunk"). */
  prefix?: string;
};

export type AudioChunk = {
  index: number;
  path: string;
  startSeconds: number;
  durationSeconds: number;
};

export function buildChunkArgs(input: string, outDir: string, segmentSeconds: number, prefix: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vn',
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1',
    '-c:a', 'pcm_s16le',
    path.join(outDir, `${prefix}-%05d.wav`)
  ];
}

/**
 * Split audio into fixed-length WAV segments (re-encoded as PCM so cuts are sample-accurate).
 * Feed it a normalized WAV for 16 kHz mono chunks. Returns chunks ordered by index with offsets.
 */
export async function chunkAudio(input: string, outDir: string, opts: ChunkOptions = {}): Promise<AudioChunk[]> {
  const seg = opts.segmentSeconds ?? 600;
  if (!(seg > 0)) throw new Error('segmentSeconds must be > 0');
  const prefix = opts.prefix ?? 'chunk';
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('Invalid prefix');
  const t = resolveTools(opts);
  await mkdir(outDir, { recursive: true });
  await runProcess(t.ffmpeg, buildChunkArgs(input, outDir, seg, prefix), { timeoutMs: t.timeoutMs, signal: opts.signal });
  const re = new RegExp(`^${prefix}-(\\d{5})\\.wav$`);
  const files = (await readdir(outDir))
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  const chunks: AudioChunk[] = [];
  let start = 0;
  for (const { f, m } of files) {
    const p = path.join(outDir, f);
    const info = await probeMedia(p, opts);
    chunks.push({ index: Number(m[1]), path: p, startSeconds: start, durationSeconds: info.durationSeconds });
    start += info.durationSeconds;
  }
  return chunks;
}

export async function isFfmpegAvailable(opts: MediaToolsOptions = {}): Promise<boolean> {
  const t = resolveTools(opts);
  try {
    await runProcess(t.ffmpeg, ['-version'], { timeoutMs: 10000 });
    await runProcess(t.ffprobe, ['-version'], { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}
