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
