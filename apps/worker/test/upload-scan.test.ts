import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMedia, type ProbeResult } from '@meetops/media-core';
import {
  scanUploadObject,
  sniffContainer,
  verifyUploadContent,
  type UploadProbe,
} from '../src/media/upload-scan.js';

const root = mkdtempSync(path.join(tmpdir(), 'upload-scan-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const file = (name: string, bytes: Buffer) => {
  const p = path.join(root, name);
  writeFileSync(p, bytes);
  return p;
};
const probeResult = (o: Partial<ProbeResult> = {}): ProbeResult => ({
  durationSeconds: 60,
  formatName: 'matroska,webm',
  streams: [{ index: 0, codecType: 'audio', codecName: 'opus', sampleRate: 48000, channels: 2 }],
  hasAudio: true,
  hasVideo: false,
  ...o,
});
const fakeProbe =
  (r: ProbeResult | Error): UploadProbe =>
  () =>
    r instanceof Error ? Promise.reject(r) : Promise.resolve(r);

describe('sniffContainer', () => {
  it('detects allowed containers from magic bytes', () => {
    expect(sniffContainer(EBML)).toBe('matroska');
    expect(sniffContainer(Buffer.from('OggS\0\0\0\0'))).toBe('ogg');
    expect(sniffContainer(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBe('wav');
    expect(sniffContainer(Buffer.from('\0\0\0\x20ftypisom'))).toBe('mov');
    expect(sniffContainer(Buffer.from('ID3\x04'))).toBe('mp3');
    expect(sniffContainer(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });
  it('returns null for anything else (html, svg, zip, pdf, exe)', () => {
    for (const s of ['<!doctype html>', '<svg xmlns=', 'PK\x03\x04', '%PDF-1.7', 'MZ\x90\0'])
      expect(sniffContainer(Buffer.from(s))).toBeNull();
  });
});

describe('verifyUploadContent (security review B 4.1)', () => {
  const webm = file('a.webm', Buffer.concat([EBML, Buffer.alloc(100)]));

  it('clean for matching magic + probe within limits', async () => {
    expect(
      await verifyUploadContent(webm, 'audio/webm;codecs=opus', fakeProbe(probeResult())),
    ).toEqual({ verdict: 'clean' });
  });

  it('rejects a declared type that does not match the bytes', async () => {
    const html = file('x.webm', Buffer.from('<!doctype html><script>alert(1)</script>'));
    expect(await verifyUploadContent(html, 'audio/webm', fakeProbe(probeResult()))).toEqual({
      verdict: 'rejected',
      code: 'content_type_mismatch',
    });
    expect(await verifyUploadContent(webm, 'audio/mpeg', fakeProbe(probeResult()))).toMatchObject({
      code: 'content_type_mismatch',
    });
  });

  it('rejects unsupported types, empty and oversized files', async () => {
    expect(await verifyUploadContent(webm, 'text/html', fakeProbe(probeResult()))).toMatchObject({
      code: 'unsupported_type',
    });
    expect(
      await verifyUploadContent(file('e', Buffer.alloc(0)), 'audio/webm', fakeProbe(probeResult())),
    ).toMatchObject({ code: 'empty_source' });
    expect(
      await verifyUploadContent(webm, 'audio/webm', fakeProbe(probeResult()), {
        maxSourceBytes: 10,
      }),
    ).toMatchObject({ code: 'source_too_large' });
  });

  it('rejects probe failures and unexpected or forbidden containers', async () => {
    const v = (r: ProbeResult | Error) => verifyUploadContent(webm, 'audio/webm', fakeProbe(r));
    expect(await v(new Error('boom'))).toMatchObject({ code: 'probe_failed' });
    expect(await v(probeResult({ formatName: 'mov,mp4' }))).toMatchObject({
      code: 'unexpected_container',
    });
    expect(await v(probeResult({ formatName: 'matroska,hls' }))).toMatchObject({
      code: 'unexpected_container',
    });
  });

  it('bounds streams, duration, stream params and decoded size (bomb guard)', async () => {
    const v = (r: ProbeResult) => verifyUploadContent(webm, 'audio/webm', fakeProbe(r));
    const a = probeResult().streams[0]!;
    expect(
      await v(probeResult({ streams: Array.from({ length: 5 }, (_, i) => ({ ...a, index: i })) })),
    ).toMatchObject({ code: 'too_many_streams' });
    expect(await v(probeResult({ streams: [], hasAudio: false }))).toMatchObject({
      code: 'no_audio',
    });
    expect(await v(probeResult({ durationSeconds: 0 }))).toMatchObject({
      code: 'duration_invalid',
    });
    expect(await v(probeResult({ durationSeconds: Number.NaN }))).toMatchObject({
      code: 'duration_invalid',
    });
    expect(await v(probeResult({ durationSeconds: 5 * 3600 }))).toMatchObject({
      code: 'duration_too_long',
    });
    expect(await v(probeResult({ streams: [{ ...a, sampleRate: 384_000 }] }))).toMatchObject({
      code: 'stream_params_exceeded',
    });
    expect(await v(probeResult({ streams: [{ ...a, channels: 64 }] }))).toMatchObject({
      code: 'stream_params_exceeded',
    });
    // 4 h of 192 kHz x 8 ch f32 is far past the decoded cap.
    expect(
      await v(
        probeResult({
          durationSeconds: 4 * 3600,
          streams: [{ ...a, sampleRate: 192_000, channels: 8 }],
        }),
      ),
    ).toMatchObject({ code: 'decoded_size_exceeded' });
    expect(
      await v(
        probeResult({
          hasVideo: true,
          streams: [a, { index: 1, codecType: 'video', width: 16384, height: 16384 }],
        }),
      ),
    ).toMatchObject({ code: 'decoded_size_exceeded' });
  });
});

describe('scanUploadObject', () => {
  const body = Buffer.concat([EBML, Buffer.alloc(100)]);
  it('streams to a temp file and verifies it', async () => {
    const r = await scanUploadObject(
      { size: async () => body.length, body: async () => Readable.from([body]) },
      'audio/webm',
      fakeProbe(probeResult()),
      { tmpRoot: root },
    );
    expect(r).toEqual({ verdict: 'clean' });
  });
  it('caps the streamed size even when HEAD under-reports it', async () => {
    const r = await scanUploadObject(
      { size: async () => 10, body: async () => Readable.from([body]) },
      'audio/webm',
      fakeProbe(probeResult()),
      { tmpRoot: root, limits: { maxSourceBytes: 50 } },
    );
    expect(r).toMatchObject({ code: 'source_too_large' });
  });
  it('rejects missing objects', async () => {
    const r = await scanUploadObject(
      { size: async () => null, body: async () => Readable.from([]) },
      'audio/webm',
      fakeProbe(probeResult()),
    );
    expect(r).toMatchObject({ code: 'empty_source' });
  });
});

function has(bin: string) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!has('ffmpeg') || !has('ffprobe'))('verifyUploadContent with real ffprobe', () => {
  const probe: UploadProbe = (p, o) => probeMedia(p, o);
  it('accepts a real opus webm and rejects it declared as mp4', async () => {
    const src = path.join(root, 'tone.webm');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:a',
      'libopus',
      src,
    ]);
    expect(await verifyUploadContent(src, 'audio/webm', probe)).toEqual({ verdict: 'clean' });
    expect(await verifyUploadContent(src, 'video/mp4', probe)).toMatchObject({
      code: 'content_type_mismatch',
    });
  });
  it('rejects bytes that only carry a valid magic header', async () => {
    const fake = file(
      'fake.webm',
      Buffer.concat([EBML, readFileSync(__filename).subarray(0, 200)]),
    );
    const r = await verifyUploadContent(fake, 'audio/webm', probe);
    expect(r.verdict).toBe('rejected');
  });
});
