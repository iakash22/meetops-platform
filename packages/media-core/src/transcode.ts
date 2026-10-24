import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { probeMedia } from './probe.js';
import { PROTOCOL_WHITELIST, resolveTools, runProcess, type MediaToolsOptions } from './run.js';

export type NormalizeOptions = MediaToolsOptions & {
  sampleRate?: number;
  channels?: number;
  /** Forced input demuxer (`-f`), e.g. from demuxerForExt(). */
  inputFormat?: string;
  /** Output duration cap in seconds (`-t`). */
  maxDurationSeconds?: number;
  /** Output size cap in bytes (`-fs`). */
  maxOutputBytes?: number;
  /**
   * Input size cap in bytes, checked with stat() before ffmpeg runs (callers pass contracts MAX_MEDIA_BYTES or a
   * lower configured cap; media-core stays dependency-free so it does not import contracts itself).
   */
  maxInputBytes?: number;
};

export class InputTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`input exceeds ${maxBytes} bytes`);
    this.name = 'InputTooLargeError';
  }
}

type NormalizeArgOptions = Pick<NormalizeOptions, 'sampleRate' | 'channels' | 'inputFormat' | 'maxDurationSeconds' | 'maxOutputBytes'>;

/** ffmpeg argv to normalize any input to PCM s16le WAV (default 16 kHz mono). */
export function buildNormalizeArgs(input: string, output: string, o: NormalizeArgOptions = {}): string[] {
  const posNum = (n: number | undefined, name: string) => {
    if (n !== undefined && !(Number.isFinite(n) && n > 0)) throw new Error(`${name} must be > 0`);
    return n;
  };
  const t = posNum(o.maxDurationSeconds, 'maxDurationSeconds');
  const fs = posNum(o.maxOutputBytes, 'maxOutputBytes');
  return [
    '-hide_banner', '-nostdin', '-y',
    ...PROTOCOL_WHITELIST,
    ...(o.inputFormat ? ['-f', o.inputFormat] : []),
    '-i', input,
    '-vn', '-sn', '-dn',
    '-ac', String(o.channels ?? 1),
    '-ar', String(o.sampleRate ?? 16000),
    '-c:a', 'pcm_s16le',
    ...(t !== undefined ? ['-t', String(t)] : []),
    ...(fs !== undefined ? ['-fs', String(Math.floor(fs))] : []),
    '-f', 'wav',
    output
  ];
}

export async function normalizeToWav(input: string, output: string, opts: NormalizeOptions = {}): Promise<string> {
  const t = resolveTools(opts);
  if (opts.maxInputBytes !== undefined) {
    if (!(Number.isFinite(opts.maxInputBytes) && opts.maxInputBytes > 0)) throw new Error('maxInputBytes must be > 0');
    const { size } = await stat(input);
    if (size > opts.maxInputBytes) throw new InputTooLargeError(size, opts.maxInputBytes);
  }
  await mkdir(path.dirname(output), { recursive: true });
  await runProcess(t.ffmpeg, buildNormalizeArgs(input, output, opts), { timeoutMs: t.timeoutMs, signal: opts.signal });
  return output;
}

export type ChunkOptions = MediaToolsOptions & {
  /** Segment length in seconds (default 600). */
  segmentSeconds?: number;
  /** Filename prefix (default "chunk"). */
  prefix?: string;
  /**
   * Cleanup behaviour (default true): remove stale `{prefix}-NNNNN.wav` files in outDir
   * before writing, and remove any partial outputs if ffmpeg or probing fails.
   * Only files matching the prefix pattern are touched; other files are left alone.
   */
  cleanup?: boolean;
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
    ...PROTOCOL_WHITELIST,
    '-f', 'wav',
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
  const cleanup = opts.cleanup ?? true;
  const t = resolveTools(opts);
  const re = new RegExp(`^${prefix}-(\\d{5})\\.wav$`);
  const removeChunks = async () => {
    const names = await readdir(outDir).catch(() => [] as string[]);
    await Promise.all(names.filter((f) => re.test(f)).map((f) => rm(path.join(outDir, f), { force: true })));
  };
  await mkdir(outDir, { recursive: true });
  if (cleanup) await removeChunks();
  try {
    await runProcess(t.ffmpeg, buildChunkArgs(input, outDir, seg, prefix), { timeoutMs: t.timeoutMs, signal: opts.signal });
    const files = (await readdir(outDir))
      .map((f) => ({ f, m: re.exec(f) }))
      .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
    const chunks: AudioChunk[] = [];
    let start = 0;
    for (const { f, m } of files) {
      const p = path.join(outDir, f);
      const info = await probeMedia(p, { ...opts, format: 'wav' });
      chunks.push({ index: Number(m[1]), path: p, startSeconds: start, durationSeconds: info.durationSeconds });
      start += info.durationSeconds;
    }
    return chunks;
  } catch (err) {
    if (cleanup) await removeChunks();
    throw err;
  }
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
