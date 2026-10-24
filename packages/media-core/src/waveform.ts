import { open } from 'node:fs/promises';

export type Waveform = {
  version: 1;
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** Number of peak buckets (= peaks.length). */
  bins: number;
  /** Max absolute amplitude per bucket, 0..1, rounded to 3 decimals. */
  peaks: number[];
};

export type WaveformOptions = { bins?: number; maxBins?: number };

export class WavFormatError extends Error {
  override readonly name = 'WavFormatError';
}

type WavInfo = { sampleRate: number; channels: number; dataOffset: number; dataBytes: number };

/** Parse a RIFF/WAVE header (PCM s16le only, as produced by normalizeToWav). Pure: takes the first bytes. */
export function parseWavHeader(buf: Buffer, fileSize: number): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new WavFormatError('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) break;
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new WavFormatError('data before fmt');
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.sampleRate < 1) throw new WavFormatError('unsupported WAV encoding (need PCM s16le)');
      // ffmpeg may leave a placeholder size when output is capped (-fs); trust the file size then.
      const dataBytes = Math.min(size === 0 || size === 0xffffffff ? Infinity : size, fileSize - body);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, dataOffset: body, dataBytes: Math.max(0, dataBytes - (dataBytes % (2 * fmt.channels))) };
    }
    off = body + size + (size % 2);
  }
  throw new WavFormatError('WAV data chunk not found');
}

/**
 * Compute a peaks waveform from a normalized PCM s16le WAV (no ffmpeg, no shell): streams the file in fixed-size
 * reads, so memory stays bounded regardless of recording length.
 */
export async function computeWaveform(wavPath: string, opts: WaveformOptions = {}): Promise<Waveform> {
  const maxBins = opts.maxBins ?? 10_000;
  const want = opts.bins ?? 1000;
  if (!Number.isInteger(want) || want < 1 || want > maxBins) throw new RangeError(`bins must be an integer in 1..${maxBins}`);
  const fh = await open(wavPath, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, 4096));
    await fh.read(head, 0, head.length, 0);
    const w = parseWavHeader(head, size);
    const frameBytes = 2 * w.channels;
    const frames = w.dataBytes / frameBytes;
    const bins = Math.max(1, Math.min(want, frames || 1));
    const peaks = new Array<number>(bins).fill(0);
    const framesPerBin = Math.max(1, frames / bins);
    const buf = Buffer.alloc(frameBytes * 8192);
    let frame = 0;
    let pos = w.dataOffset;
    const end = w.dataOffset + w.dataBytes;
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      for (let o = 0; o + frameBytes <= bytesRead; o += frameBytes, frame++) {
        const b = Math.min(bins - 1, Math.floor(frame / framesPerBin));
        for (let c = 0; c < w.channels; c++) {
          const v = Math.abs(buf.readInt16LE(o + 2 * c)) / 32768;
          if (v > peaks[b]!) peaks[b] = v;
        }
      }
    }
    return {
      version: 1,
      sampleRate: w.sampleRate,
      channels: w.channels,
      durationMs: Math.round((frames / w.sampleRate) * 1000),
      bins,
      peaks: peaks.map((p) => Math.round(Math.min(1, p) * 1000) / 1000)
    };
  } finally {
    await fh.close();
  }
}
