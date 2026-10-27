import { spawn } from 'node:child_process';
import {
  PROTOCOL_WHITELIST,
  resolveTools,
  runProcess,
  FfmpegError,
  type MediaToolsOptions,
} from './run.js';

export type MediaStreamInfo = {
  index: number;
  codecType: string;
  codecName?: string;
  sampleRate?: number;
  channels?: number;
  /** Video frame size (decoded-size guard). */
  width?: number;
  height?: number;
};

export type ProbeResult = {
  durationSeconds: number;
  formatName: string;
  sizeBytes?: number;
  bitRate?: number;
  streams: MediaStreamInfo[];
  hasAudio: boolean;
  hasVideo: boolean;
};

type RawProbe = {
  format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string };
  streams?: Array<{
    index: number;
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    width?: number;
    height?: number;
    duration?: string;
  }>;
};

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseProbeOutput(json: string): ProbeResult {
  let raw: RawProbe;
  try {
    raw = JSON.parse(json) as RawProbe;
  } catch {
    throw new FfmpegError('ffprobe returned invalid JSON', 0, json.slice(0, 500));
  }
  const streams: MediaStreamInfo[] = (raw.streams ?? []).map((s) => {
    const out: MediaStreamInfo = { index: s.index, codecType: s.codec_type ?? 'unknown' };
    if (s.codec_name) out.codecName = s.codec_name;
    const sr = num(s.sample_rate);
    if (sr !== undefined) out.sampleRate = sr;
    if (s.channels !== undefined) out.channels = s.channels;
    if (s.width !== undefined) out.width = s.width;
    if (s.height !== undefined) out.height = s.height;
    return out;
  });
  const duration =
    num(raw.format?.duration) ??
    Math.max(0, ...(raw.streams ?? []).map((s) => num(s.duration) ?? 0));
  const res: ProbeResult = {
    durationSeconds: duration,
    formatName: raw.format?.format_name ?? 'unknown',
    streams,
    hasAudio: streams.some((s) => s.codecType === 'audio'),
    hasVideo: streams.some((s) => s.codecType === 'video'),
  };
  const size = num(raw.format?.size);
  if (size !== undefined) res.sizeBytes = size;
  const br = num(raw.format?.bit_rate);
  if (br !== undefined) res.bitRate = br;
  return res;
}

/** Probe a local media file with ffprobe. */
export type ProbeOptions = MediaToolsOptions & {
  /** Force the input demuxer (`-f`); use demuxerForExt(). Strongly recommended for untrusted input. */
  format?: string;
};

export async function probeMedia(inputPath: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const t = resolveTools(opts);
  const fmt = opts.format ? ['-f', opts.format] : [];
  const { stdout } = await runProcess(
    t.ffprobe,
    [
      '-v',
      'error',
      ...PROTOCOL_WHITELIST,
      ...fmt,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '--',
      inputPath,
    ],
    { timeoutMs: t.timeoutMs, signal: opts.signal },
  );
  return parseProbeOutput(stdout);
}

/**
 * Measured audio duration (security review B, PR #269 M-1/M-2/N-1). Container metadata and packet timestamps are both
 * uploader-controlled (`setts` can rescale pts and durations), so the duration is derived from DECODED SAMPLES:
 * ffprobe decodes the first audio stream frame by frame (no output written) and the sum of `nb_samples` divided by the
 * stream sample rate is returned. Timestamps that go backwards or overlap (pts[n] + dur[n] > pts[n+1] + 1 ms) are
 * counted as `timestampFaults`; callers reject them. stdout is parsed line by line (never buffered whole) and the run
 * is bounded by the tool timeout.
 */
export async function measureAudioDuration(
  inputPath: string,
  opts: ProbeOptions & { sampleRate: number },
): Promise<{ durationSeconds: number; frames: number; samples: number; timestampFaults: number }> {
  if (!Number.isFinite(opts.sampleRate) || opts.sampleRate <= 0)
    throw new TypeError('sampleRate is required');
  const t = resolveTools(opts);
  const fmt = opts.format ? ['-f', opts.format] : [];
  const args = [
    '-v',
    'error',
    ...PROTOCOL_WHITELIST,
    ...fmt,
    '-select_streams',
    'a:0',
    '-show_entries',
    'frame=pts_time,duration_time,nb_samples',
    '-of',
    'compact=p=0',
    '--',
    inputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(t.ffprobe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    });
    let samples = 0;
    let frames = 0;
    let faults = 0;
    let prevEnd: number | null = null;
    let rest = '';
    let stderr = '';
    const line = (l: string) => {
      const kv: Record<string, string> = {};
      for (const part of l.split('|')) {
        const i = part.indexOf('=');
        if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
      }
      const n = Number(kv.nb_samples);
      if (!Number.isFinite(n) || n < 0) return;
      frames++;
      samples += n;
      const pts = Number(kv.pts_time);
      const dur = Number(kv.duration_time);
      if (Number.isFinite(pts)) {
        if (prevEnd !== null && pts + 0.001 < prevEnd) faults++;
        prevEnd = pts + (Number.isFinite(dur) ? dur : 0);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop() ?? '';
      if (rest.length > 4096) rest = '';
      lines.forEach(line);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4096);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), t.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`Failed to run ${t.ffprobe}: ${err.message}`, null, stderr));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (rest) line(rest);
      if (code === 0)
        resolve({
          durationSeconds: samples / opts.sampleRate,
          frames,
          samples,
          timestampFaults: faults,
        });
      else reject(new FfmpegError(`${t.ffprobe} exited with ${code ?? sig}`, code, stderr));
    });
  });
}
