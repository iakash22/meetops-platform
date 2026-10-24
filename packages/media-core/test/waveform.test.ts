import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { WavFormatError, computeWaveform, normalizeToWav, parseWavHeader } from '../src/index.js';

const dir = mkdtempSync(path.join(tmpdir(), 'waveform-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function wav(samples: number[], sampleRate = 16000, channels = 1, dataSize?: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataSize ?? data.length, 40);
  return Buffer.concat([h, data]);
}

function has(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('waveform (pure, no ffmpeg)', () => {
  it('computes per-bin max-abs peaks and duration', async () => {
    const p = path.join(dir, 'a.wav');
    writeFileSync(p, wav([0, 16384, -32768, 100, 0, 0, 8192, -8192]));
    const w = await computeWaveform(p, { bins: 4 });
    expect(w).toEqual({ version: 1, sampleRate: 16000, channels: 1, durationMs: 1, bins: 4, peaks: [0.5, 1, 0, 0.25] });
  });
  it('caps bins at the frame count and handles placeholder data sizes', async () => {
    const p = path.join(dir, 'b.wav');
    writeFileSync(p, wav([1000, -2000], 16000, 1, 0xffffffff));
    expect((await computeWaveform(p, { bins: 100 })).bins).toBe(2);
  });
  it('rejects non-WAV, non-PCM16 and bad bins', async () => {
    expect(() => parseWavHeader(Buffer.from('nope'), 4)).toThrow(WavFormatError);
    const bad = wav([1]);
    bad.writeUInt16LE(3, 20); // IEEE float
    expect(() => parseWavHeader(bad, bad.length)).toThrow(/PCM s16le/);
    const p = path.join(dir, 'c.wav');
    writeFileSync(p, wav([1]));
    await expect(computeWaveform(p, { bins: 0 })).rejects.toThrow(RangeError);
  });
});

describe.skipIf(!has(process.env.FFMPEG_PATH ?? 'ffmpeg'))('waveform from a real ffmpeg-normalized file', () => {
  it('normalizes to 16 kHz mono and produces 200 peaks', async () => {
    const src = path.join(dir, 'tone.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '2', src]);
    const out = await normalizeToWav(src, path.join(dir, 'n.wav'));
    const w = await computeWaveform(out, { bins: 200 });
    expect(w).toMatchObject({ sampleRate: 16000, channels: 1, bins: 200 });
    expect(w.durationMs).toBeGreaterThan(2900);
    expect(Math.max(...w.peaks)).toBeGreaterThan(0.05);
  });
});
