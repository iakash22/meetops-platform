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
  runProcess,
  assertProbedFormat,
  demuxerForExt
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
  it('normalize args force the demuxer and add -t/-fs caps', () => {
    const a = buildNormalizeArgs('in.webm', 'o.wav', { inputFormat: 'matroska', maxDurationSeconds: 60, maxOutputBytes: 1000 }).join(' ');
    expect(a).toContain('-protocol_whitelist file,pipe -f matroska -i in.webm');
    expect(a).toContain('-t 60 -fs 1000 -f wav o.wav');
    expect(() => buildNormalizeArgs('i', 'o', { maxDurationSeconds: 0 })).toThrow();
  });
  it('demuxer allowlist and probed-format checks', () => {
    expect(demuxerForExt('webm')).toBe('matroska');
    expect(demuxerForExt('M4A')).toBe('mov');
    expect(() => demuxerForExt('m3u8')).toThrow(FfmpegError);
    const p = (formatName: string) => ({ durationSeconds: 1, formatName, streams: [], hasAudio: true, hasVideo: false });
    expect(() => assertProbedFormat(p('matroska,webm'), 'matroska')).not.toThrow();
    expect(() => assertProbedFormat(p('mov,mp4,m4a,3gp,3g2,mj2'), 'mov')).not.toThrow();
    expect(() => assertProbedFormat(p('hls'), 'matroska')).toThrow(/Forbidden/);
    expect(() => assertProbedFormat(p('concat'), 'wav')).toThrow(/Forbidden/);
    expect(() => assertProbedFormat(p('ogg'), 'matroska')).toThrow(/Unexpected/);
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

  it('forced demuxer rejects an HLS playlist and a concat list disguised as media', async () => {
    const m3u8 = path.join(dir, 'evil.webm');
    writeFileSync(m3u8, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/etc/passwd\n#EXT-X-ENDLIST\n');
    await expect(probeMedia(m3u8, { format: demuxerForExt('webm') })).rejects.toThrow(FfmpegError);
    const cc = path.join(dir, 'evil.wav');
    writeFileSync(cc, "ffconcat version 1.0\nfile '/etc/passwd'\n");
    await expect(normalizeToWav(cc, path.join(dir, 'evil-out.wav'), { inputFormat: 'wav' })).rejects.toThrow(FfmpegError);
  });

  it('caps output with -t and -fs', async () => {
    const out = path.join(dir, 'capped.wav');
    await normalizeToWav(src, out, { inputFormat: 'mp3', maxDurationSeconds: 3 });
    expect((await probeMedia(out, { format: 'wav' })).durationSeconds).toBeLessThanOrEqual(3.1);
    const out2 = path.join(dir, 'capped2.wav');
    await normalizeToWav(src, out2, { inputFormat: 'mp3', maxOutputBytes: 50_000 });
    const { statSync } = await import('node:fs');
    expect(statSync(out2).size).toBeLessThanOrEqual(50_000 + 4096);
  });

  it('fails cleanly on a corrupt input', async () => {
    await expect(normalizeToWav(path.join(dir, 'missing.mp3'), path.join(dir, 'x.wav'))).rejects.toThrow(FfmpegError);
  });

  it('removes stale chunk files before writing (cleanup default)', async () => {
    const out = path.join(dir, 'stale');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'chunk-00007.wav'), 'stale');
    writeFileSync(path.join(out, 'keep.txt'), 'keep');
    const chunks = await chunkAudio(path.join(dir, 'norm', 'out.wav'), out, { segmentSeconds: 10 });
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
    await expect(chunkAudio(path.join(dir, 'norm', 'out.wav'), out, { segmentSeconds: 10, ffprobePath: '/nonexistent/ffprobe' })).rejects.toThrow(FfmpegError);
    expect(readdirSync(out)).toEqual(['other.txt']);
    await expect(chunkAudio(path.join(dir, 'missing.mp3'), out)).rejects.toThrow(FfmpegError);
    expect(readdirSync(out)).toEqual(['other.txt']);
  }, 60000);
});
