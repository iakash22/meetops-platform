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
 * Measured duration from a packet scan (security review B, PR #269 M-1/M-2). Container metadata (`format.duration`,
 * the EBML Duration element) is uploader-controlled and absent in MediaRecorder WebM, so the scan reads every packet
 * of the first audio stream (demux only, no decode) and returns max(pts + duration). Streams stdout line by line
 * (never buffered whole) and is bounded by the tool timeout.
 */
export async function measurePacketDuration(
  inputPath: string,
  opts: ProbeOptions = {},
): Promise<{ durationSeconds: number; packets: number }> {
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
    'packet=pts_time,duration_time',
    '-of',
    'csv=p=0',
    '--',
    inputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(t.ffprobe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    });
    let max = 0;
    let packets = 0;
    let rest = '';
    let stderr = '';
    const line = (l: string) => {
      const [pts, dur] = l.split(',');
      const p = Number(pts);
      if (!Number.isFinite(p)) return;
      const d = Number(dur);
      packets++;
      max = Math.max(max, p + (Number.isFinite(d) ? d : 0));
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
      if (code === 0) resolve({ durationSeconds: max, packets });
      else reject(new FfmpegError(`${t.ffprobe} exited with ${code ?? sig}`, code, stderr));
    });
  });
}
