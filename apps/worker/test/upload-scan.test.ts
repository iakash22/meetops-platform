import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import {
  scanUploadObject,
  sniffContainer,
  verifyUploadContent,
  createUploadProbe,
  type UploadProbe,
  type UploadProbeResult,
} from '../src/media/upload-scan.js';
import { containerEnd, hasTrailingData } from '../src/media/container-end.js';

const root = mkdtempSync(path.join(tmpdir(), 'upload-scan-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
/** Minimal well-formed EBML: empty EBML header + a known-size Segment of 100 bytes (no trailing data). */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x80 | 100]),
  Buffer.from([0xec, 0x80 | 98]), // Segment = one zero-filled Void
  Buffer.alloc(98),
]);
const file = (name: string, bytes: Buffer) => {
  const p = path.join(root, name);
  writeFileSync(p, bytes);
  return p;
};
const probeResult = (o: Partial<UploadProbeResult> = {}): UploadProbeResult => ({
  durationSeconds: 60,
  measuredDurationSeconds: o.measuredDurationSeconds ?? o.durationSeconds ?? 60,
  formatName: 'matroska,webm',
  streams: [{ index: 0, codecType: 'audio', codecName: 'opus', sampleRate: 48000, channels: 2 }],
  hasAudio: true,
  hasVideo: false,
  ...o,
});
const fakeProbe =
  (r: UploadProbeResult | Error): UploadProbe =>
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
  const webm = file('a.webm', WEBM);

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
    const v = (r: UploadProbeResult | Error) =>
      verifyUploadContent(webm, 'audio/webm', fakeProbe(r));
    expect(await v(new Error('boom'))).toMatchObject({ code: 'probe_failed' });
    expect(await v(probeResult({ formatName: 'mov,mp4' }))).toMatchObject({
      code: 'unexpected_container',
    });
    expect(await v(probeResult({ formatName: 'matroska,hls' }))).toMatchObject({
      code: 'unexpected_container',
    });
  });

  it('bounds streams, duration, stream params and decoded size (bomb guard)', async () => {
    const v = (r: UploadProbeResult) => verifyUploadContent(webm, 'audio/webm', fakeProbe(r));
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
    // M-1: a forged short header no longer hides a long recording; limits use the measured duration.
    expect(
      await v(probeResult({ durationSeconds: 1, measuredDurationSeconds: 5 * 3600 })),
    ).toMatchObject({ code: 'duration_mismatch' });
    expect(
      await v(probeResult({ durationSeconds: 0, measuredDurationSeconds: 5 * 3600 })),
    ).toMatchObject({ code: 'duration_too_long' });
    // M-2: MediaRecorder WebM declares no duration (0 / N/A): accepted on the measured value.
    expect(await v(probeResult({ durationSeconds: 0, measuredDurationSeconds: 30 }))).toEqual({
      verdict: 'clean',
    });
    expect(
      await v(probeResult({ durationSeconds: Number.NaN, measuredDurationSeconds: 30 })),
    ).toEqual({ verdict: 'clean' });
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

describe('trailing data (L-1)', () => {
  it('rejects bytes after a known-size Segment, an MP4 with junk after the last box, and a padded WAV', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const poly = file('poly.webm', Buffer.concat([WEBM, html]));
    expect(await verifyUploadContent(poly, 'audio/webm', fakeProbe(probeResult()))).toEqual({
      verdict: 'rejected',
      code: 'trailing_data',
    });
    const box = (type: string, n: number) => {
      const b = Buffer.alloc(8 + n);
      b.writeUInt32BE(8 + n, 0);
      b.write(type, 4, 'latin1');
      return b;
    };
    const mp4 = Buffer.concat([box('ftyp', 8), box('mdat', 16), box('moov', 8)]);
    expect(await hasTrailingData(file('ok.mp4', mp4), 'mov')).toBe(false);
    expect(await hasTrailingData(file('bad.mp4', Buffer.concat([mp4, html])), 'mov')).toBe(true);
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36, 4);
    wav.write('WAVE', 8, 'latin1');
    expect(await hasTrailingData(file('ok.wav', wav), 'wav')).toBe(false);
    expect(await hasTrailingData(file('bad.wav', Buffer.concat([wav, html])), 'wav')).toBe(true);
  });
  it('walks unknown-size Segment/Cluster (MediaRecorder) and rejects junk after the last block', async () => {
    const unknown = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const live = Buffer.from([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x80, // EBML header, empty
      0x18,
      0x53,
      0x80,
      0x67,
      ...unknown, // Segment, unknown size
      0x15,
      0x49,
      0xa9,
      0x66,
      0x80, // Info, empty
      0x1f,
      0x43,
      0xb6,
      0x75,
      ...unknown, // Cluster, unknown size
      0xe7,
      0x81,
      0x00, // Timecode 0
      0xa3,
      0x84,
      0x81,
      0x00,
      0x00,
      0x80, // SimpleBlock, 4 bytes
      0x1f,
      0x43,
      0xb6,
      0x75,
      ...unknown, // next Cluster
      0xa3,
      0x84,
      0x81,
      0x00,
      0x14,
      0x80,
    ]);
    expect(await hasTrailingData(file('live.webm', live), 'matroska')).toBe(false);
    const poly = Buffer.concat([live, Buffer.from('<html>')]);
    expect(await hasTrailingData(file('live-poly.webm', poly), 'matroska')).toBe(true);
  });
});

describe('smuggled payloads inside the container (N-2)', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const vsize = (n: number) => Buffer.from([0x40 | (n >> 8), n & 0xff]); // 2-byte EBML size
  const seg = (children: Buffer, declared = children.length) =>
    Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67]),
      vsize(declared),
      children,
    ]);
  const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80]);
  const voidEl = (payload: Buffer) =>
    Buffer.concat([Buffer.from([0xec]), vsize(payload.length), payload]);
  it('Matroska: Void with HTML is rejected, zero Void is fine', async () => {
    expect(
      await containerEnd(
        file('v-ok.webm', seg(Buffer.concat([info, voidEl(Buffer.alloc(16))]))),
        'matroska',
      ),
    ).toBe('ok');
    expect(
      await containerEnd(file('v-bad.webm', seg(Buffer.concat([info, voidEl(html)]))), 'matroska'),
    ).toBe('trailing');
  });
  it('Matroska: raw HTML hidden behind an enlarged Segment size is rejected', async () => {
    const children = Buffer.concat([info, html]);
    expect(await containerEnd(file('seg-big.webm', seg(children)), 'matroska')).toBe('trailing');
  });
  it('MP4: a free box holding HTML is rejected, an empty/zero free box is fine', async () => {
    const box = (type: string, payload: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(8 + payload.length, 0);
      h.write(type, 4, 'latin1');
      return Buffer.concat([h, payload]);
    };
    const base = [
      box('ftyp', Buffer.alloc(8)),
      box('mdat', Buffer.alloc(16)),
      box('moov', Buffer.alloc(8)),
    ];
    expect(
      await containerEnd(
        file('free-ok.mp4', Buffer.concat([...base, box('free', Buffer.alloc(0))])),
        'mov',
      ),
    ).toBe('ok');
    expect(
      await containerEnd(file('free-bad.mp4', Buffer.concat([...base, box('free', html)])), 'mov'),
    ).toBe('trailing');
    expect(
      await containerEnd(file('skip-bad.mp4', Buffer.concat([...base, box('skip', html)])), 'mov'),
    ).toBe('trailing');
  });
});

describe('scanUploadObject', () => {
  const body = WEBM;
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
  const probe = createUploadProbe();
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
  const tone = (name: string, seconds: number, extra: string[] = []) => {
    const out = path.join(root, name);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:a',
      'libopus',
      ...extra,
      out,
    ]);
    return out;
  };
  it('M-2: accepts a live (MediaRecorder-style) WebM with no Duration element', async () => {
    const live = tone('live.webm', 3, ['-live', '1']);
    expect(await verifyUploadContent(live, 'audio/webm', probe)).toEqual({ verdict: 'clean' });
  });
  it('M-1: measures the real duration (limits ignore the header)', async () => {
    const long = tone('long.webm', 20);
    expect(
      await verifyUploadContent(long, 'audio/webm', probe, { maxDurationSeconds: 10 }),
    ).toMatchObject({ code: 'duration_too_long' });
    const live = tone('long-live.webm', 20, ['-live', '1']);
    expect(
      await verifyUploadContent(live, 'audio/webm', probe, { maxDurationSeconds: 10 }),
    ).toMatchObject({ code: 'duration_too_long' });
  });
  it('L-1: a real WebM with HTML appended is rejected', async () => {
    const src = tone('poly-src.webm', 2);
    const poly = file(
      'poly-real.webm',
      Buffer.concat([readFileSync(src), Buffer.from('<html><script>x</script>')]),
    );
    expect(await verifyUploadContent(poly, 'audio/webm', probe)).toMatchObject({
      code: 'trailing_data',
    });
    const live = tone('poly-live.webm', 2, ['-live', '1']);
    const poly2 = file(
      'poly-live2.webm',
      Buffer.concat([readFileSync(live), Buffer.from('<html>x</html>')]),
    );
    expect(await verifyUploadContent(poly2, 'audio/webm', probe)).toMatchObject({
      code: 'trailing_data',
    });
  });
  const fx = (n: string) => path.join(__dirname, 'fixtures', 'media', n);
  it('tester fixtures (p2-media): MediaRecorder no-Duration WebM is clean', async () => {
    expect(
      await verifyUploadContent(fx('mediarecorder_noduration_10s.webm'), 'audio/webm', probe),
    ).toEqual({
      verdict: 'clean',
    });
  });
  it('tester fixtures: a 10 s WebM forged to declare 1 s fails a 5 s cap', async () => {
    const b = readFileSync(fx('tone_10s.webm'));
    const i = b.indexOf(Buffer.from([0x44, 0x89]));
    const sz = b[i + 2]! & 0x7f;
    if (sz === 8) b.writeDoubleBE(1000, i + 3);
    else b.writeFloatBE(1000, i + 3);
    const forged = file('forged-1s.webm', b);
    const r = await verifyUploadContent(forged, 'audio/webm', probe, { maxDurationSeconds: 5 });
    expect(r.verdict).toBe('rejected');
    expect(['duration_mismatch', 'duration_too_long']).toContain((r as { code: string }).code);
    // Even within tolerance of the header, the measured 10 s still fails the 5 s cap.
    expect(
      await verifyUploadContent(fx('tone_10s.webm'), 'audio/webm', probe, {
        maxDurationSeconds: 5,
      }),
    ).toMatchObject({ code: 'duration_too_long' });
  });
  it('tester fixtures: truncated WebM / MP4 are rejected, WebM + HTML is trailing data', async () => {
    expect(await verifyUploadContent(fx('truncated.webm'), 'audio/webm', probe)).toMatchObject({
      code: 'truncated_container',
    });
    expect(await verifyUploadContent(fx('truncated.mp4'), 'video/mp4', probe)).toMatchObject({
      verdict: 'rejected',
    });
    expect(await verifyUploadContent(fx('webm_plus_html.webm'), 'audio/webm', probe)).toMatchObject(
      {
        code: 'trailing_data',
      },
    );
    // A truncated live (no Duration) WebM: cut mid-block.
    const live = readFileSync(fx('mediarecorder_noduration_10s.webm'));
    const cut = file('live-cut.webm', live.subarray(0, Math.floor(live.length / 2)));
    expect(await verifyUploadContent(cut, 'audio/webm', probe)).toMatchObject({
      code: 'truncated_container',
    });
  });
  it('N-1: setts-remuxed WebM (timestamps rescaled) is measured from samples or rejected', async () => {
    // ts/20 + duration/20: pts claims 0.5 s, the decoded samples are 10 s.
    const div = await verifyUploadContent(fx('setts_div20.webm'), 'audio/webm', probe, {
      maxDurationSeconds: 5,
    });
    expect(div.verdict).toBe('rejected');
    expect(['timestamps_invalid', 'duration_mismatch', 'duration_too_long']).toContain(
      (div as { code: string }).code,
    );
    // ts=N*1: overlapping 1 ms steps for 20 ms frames.
    expect(await verifyUploadContent(fx('setts_n1.webm'), 'audio/webm', probe)).toMatchObject({
      code: 'timestamps_invalid',
    });
    expect(
      (await probe(fx('setts_div20.webm'), { format: 'matroska' })).measuredDurationSeconds,
    ).toBeCloseTo(10, 0);
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
