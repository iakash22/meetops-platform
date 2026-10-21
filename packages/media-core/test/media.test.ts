import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  FfmpegError,
  buildChunkArgs,
  buildNormalizeArgs,
  chunkAudio,
  normalizeToWav,
  parseProbeOutput,
  probeMedia,
  runProcess
} from '../src/index.js';

function has(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = has(process.env.FFMPEG_PATH ?? 'ffmpeg') && has(process.env.FFPROBE_PATH ?? 'ffprobe');

describe('pure helpers', () => {
  it('parses ffprobe json', () => {
    const r = parseProbeOutput(
      JSON.stringify({
        format: { duration: '12.5', format_name: 'mov,mp4', size: '1000', bit_rate: '64000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
        ]
      })
    );
    expect(r).toMatchObject({ durationSeconds: 12.5, formatName: 'mov,mp4', sizeBytes: 1000, bitRate: 64000, hasAudio: true, hasVideo: true });
    expect(r.streams[1]).toEqual({ index: 1, codecType: 'audio', codecName: 'aac', sampleRate: 48000, channels: 2 });
  });
  it('falls back to stream duration and rejects bad json', () => {
    expect(parseProbeOutput(JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', duration: '3' }] })).durationSeconds).toBe(3);
    expect(() => parseProbeOutput('nope')).toThrow(FfmpegError);
  });
  it('builds normalize args for 16k mono', () => {
    const a = buildNormalizeArgs('in.mp4', 'out.wav');
    expect(a.join(' ')).toContain('-ac 1 -ar 16000 -c:a pcm_s16le -f wav out.wav');
    expect(a).toContain('-vn');
    expect(a.join(' ')).toContain('-protocol_whitelist file,pipe -i in.mp4');
  });
  it('builds chunk args', () => {
    expect(buildChunkArgs('in.wav', '/o', 30, 'c').join(' ')).toContain('-f segment -segment_time 30');
  });
  it('caps stdout and kills the process', async () => {
    await expect(runProcess('node', ['-e', 'process.stdout.write("x".repeat(5*1024*1024))'], { timeoutMs: 10000 })).rejects.toThrow(/exceeded/);
  });
  it('reports a missing binary as FfmpegError', async () => {
    await expect(probeMedia('x', { ffprobePath: '/nonexistent/ffprobe' })).rejects.toThrow(FfmpegError);
  });
});

describe.skipIf(!HAS_FFMPEG)('with real ffmpeg', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'media-core-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'tone.mp3');

  it('probes, normalizes and chunks', async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=25', '-ac', '2', src]);
    const p = await probeMedia(src);
    expect(p.hasAudio).toBe(true);
    expect(p.durationSeconds).toBeGreaterThan(24.5);

    const wav = await normalizeToWav(src, path.join(dir, 'norm', 'out.wav'));
    const n = await probeMedia(wav);
    expect(n.formatName).toBe('wav');
    expect(n.streams[0]).toMatchObject({ codecName: 'pcm_s16le', sampleRate: 16000, channels: 1 });

    const chunks = await chunkAudio(wav, path.join(dir, 'chunks'), { segmentSeconds: 10 });
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0]!.durationSeconds).toBeCloseTo(10, 0);
    expect(chunks[2]!.startSeconds).toBeCloseTo(20, 0);
    const total = chunks.reduce((s, c) => s + c.durationSeconds, 0);
    expect(total).toBeCloseTo(n.durationSeconds, 0);
  }, 60000);

  it('refuses network inputs via protocol whitelist', async () => {
    await expect(probeMedia('http://127.0.0.1:9/x.mp3')).rejects.toThrow(FfmpegError);
  });

  it('fails cleanly on a corrupt input', async () => {
    await expect(normalizeToWav(path.join(dir, 'missing.mp3'), path.join(dir, 'x.wav'))).rejects.toThrow(FfmpegError);
  });

  it('removes stale chunk files before writing (cleanup default)', async () => {
    const out = path.join(dir, 'stale');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'chunk-00007.wav'), 'stale');
    writeFileSync(path.join(out, 'keep.txt'), 'keep');
    const chunks = await chunkAudio(src, out, { segmentSeconds: 10 });
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(existsSync(path.join(out, 'chunk-00007.wav'))).toBe(false);
    expect(existsSync(path.join(out, 'keep.txt'))).toBe(true);
  }, 60000);

  it('keeps stale files when cleanup is false', async () => {
    const out = path.join(dir, 'nocleanup');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'chunk-00007.wav'), 'stale');
    await expect(chunkAudio(src, out, { segmentSeconds: 10, cleanup: false })).rejects.toThrow(FfmpegError);
    expect(existsSync(path.join(out, 'chunk-00007.wav'))).toBe(true);
  }, 60000);

  it('removes partial outputs on failure', async () => {
    const out = path.join(dir, 'fail');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'other.txt'), 'x');
    // ffmpeg succeeds but probing the chunks fails, leaving outputs that must be removed.
    await expect(chunkAudio(src, out, { segmentSeconds: 10, ffprobePath: '/nonexistent/ffprobe' })).rejects.toThrow(FfmpegError);
    expect(readdirSync(out)).toEqual(['other.txt']);
    await expect(chunkAudio(path.join(dir, 'missing.mp3'), out)).rejects.toThrow(FfmpegError);
    expect(readdirSync(out)).toEqual(['other.txt']);
  }, 60000);
});
