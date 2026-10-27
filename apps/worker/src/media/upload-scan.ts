import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ALLOWED_MEDIA_MIME_TYPES, MAX_MEDIA_BYTES } from '@meetops/contracts';
import type { AllowedDemuxer, MediaToolsOptions, ProbeResult } from '@meetops/media-core';
import { assertProbedFormat, measureAudioDuration, probeMedia } from '@meetops/media-core';
import { containerEnd } from './container-end.js';

/**
 * Upload content verification for the scan step (security review B 4.1). The client-declared MIME type is never
 * trusted: before an upload may be marked `clean` the worker
 *   1. caps the stored size (HEAD and while streaming),
 *   2. sniffs the container magic bytes and requires them to match the declared type,
 *   3. probes with ffprobe using the forced demuxer for that type and checks the reported container,
 *   4. measures the duration from decoded samples (never container metadata or packet timestamps), rejects
 *      backwards/overlapping timestamps, (never container metadata) and rejects a declared duration that
 *      disagrees, rejects bytes trailing the container end (polyglots), and bounds duration, stream count, sample rate, channels, video frame size and the estimated decoded size
 *      (decompression-bomb guard).
 * Any failure yields `rejected` with a stable code; the caller sets scanStatus accordingly (never `clean`).
 */
export type UploadScanLimits = {
  maxSourceBytes: number;
  maxDurationSeconds: number;
  maxStreams: number;
  maxSampleRate: number;
  maxChannels: number;
  /** Upper bound of decoded PCM (f32) bytes over the whole duration, summed across audio streams. */
  maxDecodedAudioBytes: number;
  /** Upper bound of decoded video pixels per frame (width * height). */
  maxVideoPixels: number;
};

export const DEFAULT_UPLOAD_SCAN_LIMITS: UploadScanLimits = {
  maxSourceBytes: MAX_MEDIA_BYTES,
  maxDurationSeconds: 4 * 60 * 60,
  maxStreams: 4,
  maxSampleRate: 192_000,
  maxChannels: 8,
  // 4 h of 48 kHz stereo f32 = ~5.5 GB; cap a bit above that.
  maxDecodedAudioBytes: 6 * 1024 ** 3,
  maxVideoPixels: 3840 * 2160,
};

export type UploadScanCode =
  | 'unsupported_type'
  | 'source_too_large'
  | 'empty_source'
  | 'content_type_mismatch'
  | 'probe_failed'
  | 'unexpected_container'
  | 'no_audio'
  | 'too_many_streams'
  | 'duration_invalid'
  | 'duration_too_long'
  | 'stream_params_exceeded'
  | 'decoded_size_exceeded'
  | 'duration_mismatch'
  | 'trailing_data'
  | 'truncated_container'
  | 'timestamps_invalid';

export type UploadScanResult = { verdict: 'clean' } | { verdict: 'rejected'; code: UploadScanCode };

/**
 * Probe result plus the duration MEASURED by a packet scan. `durationSeconds` (container metadata) is
 * uploader-controlled and missing in MediaRecorder WebM, so every limit uses `measuredDurationSeconds`.
 */
export type UploadProbeResult = ProbeResult & {
  /** From decoded samples of the first audio stream (never pts or container metadata). */
  measuredDurationSeconds: number;
  /** Frames whose pts went backwards or overlapped the previous frame (forged/remuxed timestamps). */
  timestampFaults?: number;
};
export type UploadProbe = (
  file: string,
  opts: { format: AllowedDemuxer },
) => Promise<UploadProbeResult>;

/** Production probe: ffprobe format/streams + a bounded packet scan (media-core). */
export function createUploadProbe(
  tools: MediaToolsOptions & { maxDurationSeconds?: number } = {},
): UploadProbe {
  const { maxDurationSeconds = DEFAULT_UPLOAD_SCAN_LIMITS.maxDurationSeconds, ...toolOpts } = tools;
  return async (file, opts) => {
    const p = await probeMedia(file, { ...toolOpts, format: opts.format });
    const rate = p.streams.find((s) => s.codecType === 'audio')?.sampleRate ?? 0;
    // No audio / no rate: report 0 and let verifyUploadContent reject (no_audio / duration_invalid).
    if (!(rate > 0)) return { ...p, measuredDurationSeconds: 0, timestampFaults: 0 };
    // Decoding stops just past the cap (N-3), so an over-long file is reported as such without decoding it all.
    const m = await measureAudioDuration(file, {
      ...toolOpts,
      format: opts.format,
      sampleRate: rate,
      maxDurationSeconds,
    });
    return { ...p, measuredDurationSeconds: m.durationSeconds, timestampFaults: m.timestampFaults };
  };
}

/** Declared and measured duration may differ by this much (container rounding, encoder padding). */
const DURATION_TOLERANCE = (measured: number) => Math.max(2, measured * 0.05);

/** Declared MIME (base type) -> the only demuxer ffprobe may use for it. */
const DEMUXER_BY_MIME: Record<(typeof ALLOWED_MEDIA_MIME_TYPES)[number], AllowedDemuxer> = {
  'audio/webm': 'matroska',
  'video/webm': 'matroska',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mov',
  'video/mp4': 'mov',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export function demuxerForMime(mime: string): AllowedDemuxer | null {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return (DEMUXER_BY_MIME as Record<string, AllowedDemuxer | undefined>)[base] ?? null;
}

/** Container detected from the first bytes, or null when it is none of the allowed ones. */
export function sniffContainer(head: Buffer): AllowedDemuxer | null {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'matroska'; // EBML
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WAVE'
  )
    return 'wav';
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mov';
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  return null;
}

const reject = (code: UploadScanCode): UploadScanResult => ({ verdict: 'rejected', code });

/** Verify a downloaded upload on local disk against its declared MIME type. Never throws for bad content. */
export async function verifyUploadContent(
  file: string,
  declaredMime: string,
  probe: UploadProbe,
  limits: Partial<UploadScanLimits> = {},
): Promise<UploadScanResult> {
  const l = { ...DEFAULT_UPLOAD_SCAN_LIMITS, ...limits };
  const demuxer = demuxerForMime(declaredMime);
  if (!demuxer) return reject('unsupported_type');
  const { size } = await stat(file);
  if (size === 0) return reject('empty_source');
  if (size > l.maxSourceBytes) return reject('source_too_large');

  const fh = await open(file, 'r');
  const head = Buffer.alloc(64);
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  if (sniffContainer(head) !== demuxer) return reject('content_type_mismatch');
  const end = await containerEnd(file, demuxer);
  if (end === 'trailing') return reject('trailing_data');
  if (end === 'truncated') return reject('truncated_container');

  let p: UploadProbeResult;
  try {
    p = await probe(file, { format: demuxer });
  } catch {
    return reject('probe_failed');
  }
  try {
    assertProbedFormat(p, demuxer);
  } catch {
    return reject('unexpected_container');
  }
  if (p.streams.length > l.maxStreams) return reject('too_many_streams');
  const audio = p.streams.filter((s) => s.codecType === 'audio');
  if (!p.hasAudio || audio.length === 0) return reject('no_audio');
  // Limits use the measured duration only. A missing declared duration (MediaRecorder WebM) is fine; a declared one
  // that disagrees with the packets is a forged header.
  if ((p.timestampFaults ?? 0) > 0) return reject('timestamps_invalid');
  const duration = p.measuredDurationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) return reject('duration_invalid');
  if (duration > l.maxDurationSeconds) return reject('duration_too_long');
  // N-5: the format duration is the max across streams (video may legitimately outlast audio), so prefer the
  // declared AUDIO stream duration when the container states one.
  const declared = p.audioDurationSeconds ?? p.durationSeconds;
  if (
    Number.isFinite(declared) &&
    declared > 0 &&
    Math.abs(declared - duration) > DURATION_TOLERANCE(duration)
  )
    return reject('duration_mismatch');

  let decoded = 0;
  for (const s of audio) {
    const rate = s.sampleRate ?? 0;
    const ch = s.channels ?? 0;
    if (rate <= 0 || ch <= 0 || rate > l.maxSampleRate || ch > l.maxChannels)
      return reject('stream_params_exceeded');
    decoded += rate * ch * 4 * duration;
  }
  if (decoded > l.maxDecodedAudioBytes) return reject('decoded_size_exceeded');
  for (const s of p.streams) {
    if (s.codecType === 'video' && (s.width ?? 0) * (s.height ?? 0) > l.maxVideoPixels)
      return reject('decoded_size_exceeded');
  }
  return { verdict: 'clean' };
}

/** Source of an upload object: a HEAD size and a streaming body. Storage-agnostic so any adapter can back it. */
export type UploadObjectSource = {
  size(): Promise<number | null>;
  body(): Promise<Readable>;
};

/**
 * Scan one stored upload: HEAD-check the size, stream it to a private temp dir with a hard byte cap (defends against
 * HEAD/GET races), then verifyUploadContent. The temp dir is always removed.
 */
export async function scanUploadObject(
  source: UploadObjectSource,
  declaredMime: string,
  probe: UploadProbe,
  opts: { limits?: Partial<UploadScanLimits>; tmpRoot?: string } = {},
): Promise<UploadScanResult> {
  const l = { ...DEFAULT_UPLOAD_SCAN_LIMITS, ...opts.limits };
  if (!demuxerForMime(declaredMime)) return reject('unsupported_type');
  const size = await source.size();
  if (size === null || size === 0) return reject('empty_source');
  if (size > l.maxSourceBytes) return reject('source_too_large');
  const dir = await mkdtemp(path.join(opts.tmpRoot ?? tmpdir(), 'upload-scan-'));
  try {
    const file = path.join(dir, 'source');
    let n = 0;
    let tooLarge = false;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        n += chunk.length;
        if (n > l.maxSourceBytes) {
          tooLarge = true;
          return cb(new Error('source_too_large'));
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(await source.body(), cap, createWriteStream(file, { mode: 0o600 }));
    } catch (err) {
      if (tooLarge) return reject('source_too_large');
      throw err;
    }
    return await verifyUploadContent(file, declaredMime, probe, l);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
