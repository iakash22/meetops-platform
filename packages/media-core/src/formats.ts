import { FfmpegError } from './run.js';
import type { ProbeResult } from './probe.js';

/**
 * Input demuxer allowlist. Every ffmpeg/ffprobe invocation forces `-f <demuxer>` from this list, so
 * playlist/indirection demuxers (hls, concat, ffconcat, image2, lavfi, sdp, rtp, tee, ...) are never
 * auto-selected from file contents.
 */
export const DEMUXER_BY_EXT = {
  webm: 'matroska',
  mkv: 'matroska',
  ogg: 'ogg',
  mp3: 'mp3',
  m4a: 'mov',
  mp4: 'mov',
  wav: 'wav'
} as const;
export type MediaExt = keyof typeof DEMUXER_BY_EXT;
export type AllowedDemuxer = (typeof DEMUXER_BY_EXT)[MediaExt];

/** ffprobe `format_name` values each allowed demuxer may report. */
const FORMAT_NAMES: Record<AllowedDemuxer, readonly string[]> = {
  matroska: ['matroska', 'webm'],
  ogg: ['ogg'],
  mp3: ['mp3'],
  mov: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  wav: ['wav']
};

/** Containers that must never be accepted, even if a probe reports them alongside an allowed name. */
export const FORBIDDEN_FORMATS = ['hls', 'applehttp', 'concat', 'ffconcat', 'playlist', 'm3u8', 'm3u', 'dash', 'image2', 'lavfi', 'sdp', 'rtp', 'rtsp', 'tee', 'data', 'subfile'];

export function demuxerForExt(ext: string): AllowedDemuxer {
  const d = (DEMUXER_BY_EXT as Record<string, AllowedDemuxer | undefined>)[ext.toLowerCase()];
  if (!d) throw new FfmpegError('Unsupported media extension', null, '');
  return d;
}

/** After probing (with the forced demuxer), reject anything that is not exactly the expected container. */
export function assertProbedFormat(probe: ProbeResult, demuxer: AllowedDemuxer): void {
  const names = probe.formatName.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0 || names.some((n) => FORBIDDEN_FORMATS.includes(n))) {
    throw new FfmpegError('Forbidden container format', null, '');
  }
  if (!names.some((n) => FORMAT_NAMES[demuxer].includes(n))) throw new FfmpegError('Unexpected container format', null, '');
}
