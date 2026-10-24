import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { InputTooLargeError, normalizeToWav } from '../src/index.js';

const dir = mkdtempSync(path.join(tmpdir(), 'mc-cap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('normalizeToWav maxInputBytes', () => {
  it('rejects an input larger than the cap before spawning ffmpeg', async () => {
    const input = path.join(dir, 'in.webm');
    writeFileSync(input, Buffer.alloc(10));
    const out = path.join(dir, 'out', 'n.wav');
    const err = await normalizeToWav(input, out, { maxInputBytes: 9, ffmpegPath: '/nonexistent/ffmpeg' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputTooLargeError);
    expect(err).toMatchObject({ sizeBytes: 10, maxBytes: 9 });
    expect(existsSync(path.dirname(out))).toBe(false);
  });
  it('rejects a non-positive cap', async () => {
    await expect(normalizeToWav(path.join(dir, 'x'), path.join(dir, 'y.wav'), { maxInputBytes: 0 })).rejects.toThrow(/maxInputBytes/);
  });
  it('passes an input at the cap through to ffmpeg', async () => {
    const input = path.join(dir, 'ok.webm');
    writeFileSync(input, Buffer.alloc(9));
    const err = await normalizeToWav(input, path.join(dir, 'o2', 'n.wav'), { maxInputBytes: 9, ffmpegPath: '/nonexistent/ffmpeg' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(InputTooLargeError); // fails only because the fake ffmpeg does not exist
  });
});
