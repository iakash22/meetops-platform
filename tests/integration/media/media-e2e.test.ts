/**
 * P2 media end to end (dummy media only): API upload routes (#196) and recording sessions (#197) -> presigned PUT
 * into a throwaway MinIO bucket -> `process_upload` job over BullMQ/Redis -> worker content scan (#269/#274) with
 * real ffprobe -> normalize (processing) -> presigned download headers and bucket privacy.
 *
 * Needs QA_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY and QA_EXTERNAL_REDIS_URL (or Docker for Redis is NOT used here:
 * the suite skips with a reason when either is unreachable). ffmpeg/ffprobe must be on PATH.
 * Large fixtures (2 min, 30 min) are generated at test time only with QA_MEDIA_LARGE=1.
 *
 * Known open bugs are `it.fails` with their reference so the suite stays green while documenting them.
 * #269 M-1/M-2/L-1 (c52342c) and N-1/N-2 (7659ed2) are fixed and are normal tests here. Still open (it.fails):
 * N-2b (HTML in CRC-32 / MP4 uuid), N-4 (6 kbit/s Opus false positive), N-5 (video outlasting audio false
 * positive), zero-width filename characters.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMinioBucket,
  minioReachable,
  sha256B64,
  sha256Hex,
  type MinioBucket,
} from '../../support/minio.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app/worker modules are loaded dynamically
type Any = any;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const imp = (rel: string): Promise<Any> => import(pathToFileURL(path.join(root, rel)).href);
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fx = (n: string) => readFile(path.join(FIX, n));

const hasFfmpeg =
  spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const redisUrl = process.env.QA_EXTERNAL_REDIS_URL;
const LARGE = process.env.QA_MEDIA_LARGE === '1';
// Needs the content scan (#269) + scan job (#274) and the storage download headers (#269).
const required = [
  'apps/worker/src/media/upload-scan.ts',
  'apps/worker/src/media/upload-scan-job.ts',
  'packages/storage/src/download-headers.ts',
];
const missing = required.filter((f) => !existsSync(path.join(root, f)));
const minioOk = missing.length === 0 && (await minioReachable());
let redisOk = false;
if (redisUrl) {
  const { Redis } = await import('ioredis');
  const r = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
  try {
    await r.connect();
    redisOk = (await r.ping()) === 'PONG';
  } catch {
    redisOk = false;
  } finally {
    r.disconnect();
  }
}
const skipReason = missing.length
  ? `scan worker not on this branch (#269/#274): missing ${missing.join(', ')}`
  : !minioOk
    ? 'MinIO not reachable (set QA_MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY)'
    : !redisOk
      ? 'Redis not reachable (set QA_EXTERNAL_REDIS_URL)'
      : !hasFfmpeg
        ? 'ffmpeg/ffprobe not on PATH'
        : '';
if (skipReason) console.warn(`[media-e2e] skipped: ${skipReason}`);

const consent = () => ({
  consentVersion: '2026-10',
  attestedAt: new Date(Date.now() - 1000).toISOString(),
  method: 'all_parties_consented',
});

/** Whole-run log capture: nothing written to stdout/stderr may contain secrets, object keys or file bytes. */
const logged: string[] = [];
const unhandled: unknown[] = [];

describe.skipIf(!!skipReason)('media e2e (MinIO + Redis + ffprobe)', () => {
  let mb: MinioBucket;
  let w: Any;
  let tmpRoot: string;
  let queue: Any;
  let worker: Any;
  let events: Any;
  let redis: Any;
  const prefix = `qa:it:media:${randomBytes(6).toString('hex')}`;
  const restore: (() => void)[] = [];

  beforeAll(async () => {
    for (const s of [process.stdout, process.stderr]) {
      const orig = s.write.bind(s);
      s.write = ((c: string | Uint8Array, ...a: unknown[]) => {
        logged.push(typeof c === 'string' ? c : Buffer.from(c).toString('latin1'));
        return (orig as Any)(c, ...a);
      }) as typeof s.write;
      restore.push(() => (s.write = orig));
    }
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    restore.push(() => process.off('unhandledRejection', onUnhandled));

    tmpRoot = await mkdtemp(path.join(tmpdir(), 'qa-media-scan-'));
    mb = await createMinioBucket();

    const mods = await imp('apps/api/src/modules/index.ts');
    const helpers = await imp('apps/api/test/helpers.ts');
    const scan = await imp('apps/worker/src/media/upload-scan-job.ts');
    const mediaCore = await imp('packages/media-core/src/index.ts');
    const qreq = createRequire(path.join(root, 'packages/queue/package.json'));
    const { Queue, Worker, QueueEvents } = await import(pathToFileURL(qreq.resolve('bullmq')).href);
    const { Redis } = await import('ioredis');

    // Production probe from #269 (ffprobe + packet-scan duration) when present; else metadata only (older #269).
    const scanCore = await imp('apps/worker/src/media/upload-scan.ts');
    const uploadProbe =
      typeof scanCore.createUploadProbe === 'function'
        ? scanCore.createUploadProbe({ timeoutMs: 120_000 })
        : async (file: string, o: { format: string }) => {
            const p = await mediaCore.probeMedia(file, { format: o.format, timeoutMs: 120_000 });
            return { ...p, measuredDurationSeconds: p.durationSeconds };
          };
    const base = mods.inMemoryMediaAdapters();
    const media = { ...base, signer: mb.signer };
    const conn = () => new Redis(redisUrl!, { maxRetriesPerRequest: null });
    redis = conn();
    const qname = 'media-processing';
    queue = new Queue(qname, { connection: conn(), prefix });
    events = new QueueEvents(qname, { connection: conn(), prefix });
    await events.waitUntilReady();
    // API -> BullMQ: the real enqueue path instead of the in-memory queue.
    media.jobs = {
      enqueue: async (job: Any) => void (await queue.add(job.kind, job, { attempts: 1 })),
    };
    const files = base.files;
    worker = new Worker(
      qname,
      async (job: Any) =>
        scan.processUploadScan(job.data, {
          findUpload: async (org: string, id: string) => files.findById(org, id),
          setScanStatus: async (org: string, id: string, st: string) =>
            files.setStatus(org, id, 'processing', st),
          source: (key: string) => mb.source(key),
          probe: uploadProbe,
          tmpRoot,
        }),
      { connection: conn(), prefix, concurrency: 1 },
    );

    const app = await helpers.buildApp(mods.defaultModuleDeps({ media }));
    const owner = await helpers.signupAndLogin(app, 'qa-media-owner@example.com');
    const org = (await owner.post('/orgs', { name: 'QA Media' })).json().organization.id as string;
    const meetingId = (
      await owner.post(`/orgs/${org}/meetings/resolve`, {
        source: 'extension',
        externalMeetingUrl: 'https://meet.google.com/qaa-media-tst',
        title: 'QA media',
      })
    ).json().meetingId as string;
    w = {
      app,
      owner,
      org,
      meetingId,
      files,
      sessions: base.sessions,
      mediaCore,
      scan,
      probe: uploadProbe,
    };
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close();
    if (redis) {
      let cursor = '0';
      do {
        const [c, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
        cursor = c;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
      redis.disconnect();
    }
    await w?.app.close();
    await mb?.destroy();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    for (const r of restore.reverse()) r();
  });

  type Result = { stage: string; scan?: string; code?: string; http?: number };

  /** Full pipeline for one file. Returns the stage it stopped at. */
  async function pipeline(
    name: string,
    body: Buffer,
    mimeType: string,
    filename = name,
  ): Promise<Result> {
    const init = await w.owner.post(`/orgs/${w.org}/uploads`, {
      filename,
      mimeType,
      sizeBytes: body.length,
      checksumSha256: sha256B64(body),
      meetingId: w.meetingId,
      consent: consent(),
    });
    if (init.statusCode !== 201) return { stage: 'init', http: init.statusCode };
    const { fileObjectId, upload } = init.json();
    const put = await fetch(String(upload.url), {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(body),
    });
    if (!put.ok) return { stage: 'put', http: put.status };
    const done = await w.owner.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {});
    if (done.statusCode !== 200) return { stage: 'complete', http: done.statusCode };
    const job = (await queue.getJobs(['waiting', 'active', 'completed', 'failed'])).find(
      (j: Any) => j.data.subjectId === fileObjectId,
    );
    const out = await job.waitUntilFinished(events, 120_000);
    expect(await readdir(tmpRoot)).toEqual([]); // scan temp dir always removed
    if (out.status !== 'clean') {
      // #274 M-3: a failed scan quarantines (older #274: rejected); never clean, never downloadable.
      const failed = await w.files.findById(w.org, fileObjectId);
      expect(['quarantined', 'rejected']).toContain(failed.scanStatus);
      expect(failed.scanStatus).toBe(out.status);
      const dl404 = await w.owner.get(`/orgs/${w.org}/uploads/${fileObjectId}/download-url`);
      expect(dl404.statusCode).toBe(404);
      return { stage: 'scan', scan: 'rejected', code: out.result?.code };
    }
    const row = await w.files.findById(w.org, fileObjectId);
    expect(row.scanStatus).toBe('clean');
    // processing: normalize the stored object to 16 kHz mono WAV
    const dir = await mkdtemp(path.join(tmpRoot, 'proc-'));
    try {
      const src = path.join(dir, 'in');
      await writeFile(src, await mb.getBuffer(String(row.key)));
      const wav = await w.mediaCore.normalizeToWav(src, path.join(dir, 'out.wav'), {
        timeoutMs: 120_000,
      });
      const p = await w.mediaCore.probeMedia(wav, { format: 'wav' });
      expect(p.hasAudio).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // download: presigned GET forces attachment + fixed type; unsigned GET is denied (private bucket)
    const dl = await w.owner.get(`/orgs/${w.org}/uploads/${fileObjectId}/download-url`);
    expect(dl.statusCode).toBe(200);
    const g = await fetch(String(dl.json().url));
    expect(g.status).toBe(200);
    expect(g.headers.get('content-disposition')).toBe('attachment');
    expect(g.headers.get('content-type')).toBe(mimeType.split(';')[0]);
    expect(Buffer.from(await g.arrayBuffer()).equals(body)).toBe(true);
    const anon = await fetch(`${mb.endpoint}/${mb.bucket}/${row.key}`);
    expect(anon.status).toBe(403);
    return { stage: 'download', scan: 'clean' };
  }

  const good: [string, string][] = [
    ['speech_10s_1ch.wav', 'audio/wav'],
    ['speech_10s_1ch.mp3', 'audio/mpeg'],
    ['speech_10s_1ch.m4a', 'audio/mp4'],
    ['speech_10s_1ch.webm', 'audio/webm'],
    ['speech_10s_1ch.mp4', 'video/mp4'],
    ['tone_10s_2ch.webm', 'audio/webm;codecs=opus'],
    ['tone_10s_2ch.mp3', 'audio/mpeg'],
    ['silent_10s_2ch.mp4', 'video/mp4'],
    ['silent_10s_1ch.m4a', 'audio/mp4'],
  ];
  it.each(good)(
    'good %s (%s) -> clean, processed, private attachment download',
    async (n, mime) => {
      expect(await pipeline(n, await fx(n), mime)).toEqual({ stage: 'download', scan: 'clean' });
    },
  );

  const bad: [string, string, () => Promise<Buffer>, Partial<Result>][] = [
    [
      'PNG renamed .mp4',
      'video/mp4',
      () => fx('really_png.mp4'),
      { stage: 'scan', code: 'content_type_mismatch' },
    ],
    ['truncated mp4', 'video/mp4', () => fx('truncated.mp4'), { stage: 'scan', scan: 'rejected' }],
    [
      'ELF renamed .webm',
      'audio/webm',
      async () => elf(),
      { stage: 'scan', code: 'content_type_mismatch' },
    ],
    [
      'resolution bomb (8192x4320 H.264, 105 KB)',
      'video/mp4',
      () => fx('bomb_resolution.mp4'),
      { stage: 'scan', code: 'decoded_size_exceeded' },
    ],
    [
      'duration bomb (5 KB WebM, Duration 10 days)',
      'audio/webm',
      () => fx('bomb_duration_10days.webm'),
      { stage: 'scan', scan: 'rejected' },
    ],
    [
      'webm declared as audio/mpeg',
      'audio/mpeg',
      () => fx('speech_10s_1ch.webm'),
      { stage: 'scan', code: 'content_type_mismatch' },
    ],
  ];
  it.each(bad)('bad %s -> rejected, no crash, no temp files', async (_n, mime, make, want) => {
    const r = await pipeline(
      _n,
      await make(),
      mime,
      'bad.bin.' + (mime.includes('mp4') ? 'mp4' : 'webm'),
    );
    expect(r).toMatchObject(want);
  });

  it('zero-byte file is refused at init (schema 400)', async () => {
    expect(await pipeline('empty.webm', Buffer.alloc(0), 'audio/webm')).toEqual({
      stage: 'init',
      http: 400,
    });
  });

  it('declared size just over the 1.4e9 cap is refused at init, and the scan rejects a sparse oversize file', async () => {
    const r = await w.owner.post(`/orgs/${w.org}/uploads`, {
      filename: 'big.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1_400_000_001,
      checksumSha256: sha256B64(Buffer.from('x')),
      consent: consent(),
    });
    expect(r.statusCode).toBe(400);
    const dir = await mkdtemp(path.join(tmpRoot, 'sparse-'));
    try {
      const f = path.join(dir, 'sparse.webm');
      await writeFile(f, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      await truncate(f, 1_400_000_001); // sparse: never filled
      expect((await stat(f)).blocks * 512).toBeLessThan(1_000_000);
      const probe = () => Promise.reject(new Error('must not probe'));
      const scanMod = await imp('apps/worker/src/media/upload-scan.ts');
      expect(await scanMod.verifyUploadContent(f, 'audio/webm', probe)).toEqual({
        verdict: 'rejected',
        code: 'source_too_large',
      });
      // HEAD/GET race: HEAD says small but the body streams past the cap -> rejected, temp removed
      const { Readable } = await import('node:stream');
      const src = {
        size: async () => 10,
        body: async () =>
          Readable.from(
            (function* () {
              for (let i = 0; i < 4; i++) yield Buffer.alloc(1024);
            })(),
          ),
      };
      expect(
        await scanMod.scanUploadObject(src, 'audio/webm', probe, {
          limits: { maxSourceBytes: 2048 },
          tmpRoot,
        }),
      ).toEqual({ verdict: 'rejected', code: 'source_too_large' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['control chars + line breaks', 'evil\u0001\u001b[31m\nline\r.webm'],
    ['bidi override', 'evil\u202egpj.webm'],
    ['isolate', 'iso\u2066late.webm'],
  ])('filename with %s is refused at init (400)', async (_n, filename) => {
    expect(await pipeline('x', await fx('tone_10s_2ch.webm'), 'audio/webm', filename)).toEqual({
      stage: 'init',
      http: 400,
    });
  });

  it.fails(
    'filename with zero-width / invisible chars (U+200B, U+2060, U+FEFF) is refused (finding: accepted)',
    async () => {
      expect(
        await pipeline(
          'x',
          await fx('tone_10s_2ch.webm'),
          'audio/webm',
          'inv\u200b\u2060\ufeffisible.webm',
        ),
      ).toEqual({ stage: 'init', http: 400 });
    },
  );

  // #269 fixes (head c52342c): measured packet duration, duration_mismatch, trailing_data.
  it('#269 M-2 (fixed): MediaRecorder-style WebM with no Duration element is accepted', async () => {
    expect(
      await pipeline('mr.webm', await fx('mediarecorder_noduration_10s.webm'), 'audio/webm'),
    ).toEqual({ stage: 'download', scan: 'clean' });
  });

  it.each([
    ['WebM + appended HTML', 'tone_10s_2ch.webm', 'audio/webm'],
    ['MediaRecorder WebM + appended HTML', 'mediarecorder_noduration_10s.webm', 'audio/webm'],
    ['MP4 + HTML after the last box', 'speech_10s_1ch.mp4', 'video/mp4'],
  ])('#269 L-1 (fixed): %s -> rejected trailing_data', async (_n, f, mime) => {
    const b = Buffer.concat([await fx(f), HTML]);
    expect(await pipeline(f, b, mime)).toMatchObject({ stage: 'scan', code: 'trailing_data' });
  });

  it('#269 M-1 (fixed, truncation): WebM cut to 3 KB of 24 KB (header says 10 s) -> duration_mismatch', async () => {
    expect(await pipeline('trunc.webm', await fx('truncated.webm'), 'audio/webm')).toMatchObject({
      stage: 'scan',
      code: expect.stringMatching(/^(duration_mismatch|truncated_container)$/),
    });
  });

  it.each([
    ['lower (10 s as 1 s)', 1000],
    ['higher (10 s as 100 s)', 100_000],
  ])('#269 M-1 (fixed): Duration forged %s -> duration_mismatch', async (_n, ms) => {
    const b = forgeWebmDuration(await fx('speech_10s_1ch.webm'), ms);
    expect(await pipeline('forged.webm', b, 'audio/webm')).toMatchObject({
      stage: 'scan',
      code: 'duration_mismatch',
    });
  });

  it('#269 N-1 (fixed): packet timestamps squeezed 20x (setts=ts=N*1) are rejected', async () => {
    const dir = await mkdtemp(path.join(tmpRoot, 'n1-'));
    try {
      const src = path.join(dir, 'in.webm');
      const out = path.join(dir, 'sq.webm');
      await writeFile(src, await fx('speech_10s_1ch.webm'));
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        src,
        '-c',
        'copy',
        '-bsf:a',
        'setts=ts=N*1',
        out,
      ]);
      const scanMod = await imp('apps/worker/src/media/upload-scan.ts');
      expect(
        await scanMod.verifyUploadContent(out, 'audio/webm', w.probe, { maxDurationSeconds: 5 }),
      ).toMatchObject({ verdict: 'rejected' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('#269 N-2 (fixed): HTML inside a WebM Void element at the end of the Segment is rejected', async () => {
    expect(
      (
        await pipeline(
          'void.webm',
          webmWithTail(await fx('speech_10s_1ch.webm'), true),
          'audio/webm',
        )
      ).scan,
    ).toBe('rejected');
  });

  it('#269 N-2 (fixed): HTML after the last Cluster with the Segment size grown to cover it is rejected', async () => {
    expect(
      (
        await pipeline(
          'grown.webm',
          webmWithTail(await fx('speech_10s_1ch.webm'), false),
          'audio/webm',
        )
      ).scan,
    ).toBe('rejected');
  });

  it('#269 N-2 (fixed): HTML inside a trailing MP4 `free` box is rejected', async () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(8 + HTML.length);
    const b = Buffer.concat([await fx('speech_10s_1ch.mp4'), len, Buffer.from('free'), HTML]);
    expect((await pipeline('free.mp4', b, 'video/mp4')).scan).toBe('rejected');
  });

  // #269 @7659ed2: decoded-sample duration, timestamp faults, exact Segment size, zero-only padding, truncation.
  const mkEl = (id: number[], payload: Buffer) =>
    Buffer.concat([
      Buffer.from([...id, 0x40 | (payload.length >> 8), payload.length & 0xff]),
      payload,
    ]);
  const growSeg = (src: Buffer, tail: Buffer) => {
    const b = Buffer.from(src);
    const i = b.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
    const len = 9 - b[i + 4]!.toString(2).length;
    let v = 0n;
    for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(b[i + 4 + k]!);
    let nv = ((v & ((1n << BigInt(7 * len)) - 1n)) + BigInt(tail.length)) | (1n << BigInt(7 * len));
    for (let k = len - 1; k >= 0; k--) {
      b[i + 4 + k] = Number(nv & 0xffn);
      nv >>= 8n;
    }
    return Buffer.concat([b, tail]);
  };
  const VOID = [0xec];
  it.each([
    [
      'Void with one non-zero byte',
      () => mkEl(VOID, Buffer.concat([Buffer.alloc(40), Buffer.from([1]), Buffer.alloc(40)])),
      'trailing_data',
    ],
    ['nested Void', () => mkEl(VOID, mkEl(VOID, Buffer.alloc(16))), 'trailing_data'],
  ] as const)('#269 N-2 (fixed): WebM %s -> rejected', async (_n, tail, code) => {
    const b = growSeg(await fx('speech_10s_1ch.webm'), tail());
    expect(await pipeline('v.webm', b, 'audio/webm')).toMatchObject({ stage: 'scan', code });
  });

  it('#269 N-2: an all-zero Void inside the Segment stays clean', async () => {
    const b = growSeg(await fx('speech_10s_1ch.webm'), mkEl(VOID, Buffer.alloc(64)));
    expect(await pipeline('z.webm', b, 'audio/webm')).toEqual({ stage: 'download', scan: 'clean' });
  });

  it.each([
    ['WebM', 'speech_10s_1ch.webm', 'audio/webm'],
    ['MP4', 'speech_10s_1ch.mp4', 'video/mp4'],
    ['WAV', 'speech_10s_1ch.wav', 'audio/wav'],
    ['MediaRecorder WebM', 'mediarecorder_noduration_10s.webm', 'audio/webm'],
  ])('#269 truncation (fixed): %s cut in half -> truncated_container', async (_n, f, mime) => {
    const b = await fx(f);
    expect(await pipeline(f, b.subarray(0, b.length >> 1), mime)).toMatchObject({
      stage: 'scan',
      code: 'truncated_container',
    });
  });

  it('#269 N-1 (fixed): a backwards timestamp jump -> timestamps_invalid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-media-' + 'nm-'));
    try {
      const src = path.join(dir, 'in.webm');
      const out = path.join(dir, 'nm.webm');
      await writeFile(src, await fx('speech_10s_1ch.webm'));
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        src,
        '-c',
        'copy',
        '-bsf:a',
        'setts=ts=if(eq(N\\,200)\\,TS-2000\\,TS)',
        out,
      ]);
      expect(await pipeline('nm.webm', await readFile(out), 'audio/webm')).toMatchObject({
        stage: 'scan',
        code: 'timestamps_invalid',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('video-only MP4 -> no_audio', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-media-' + 'vo-'));
    try {
      const out = path.join(dir, 'v.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=160x120:r=5:d=3',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        out,
      ]);
      expect(await pipeline('v.mp4', await readFile(out), 'video/mp4')).toMatchObject({
        stage: 'scan',
        code: 'no_audio',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.fails('new N-2b: HTML inside a trailing MP4 `uuid` box is rejected', async () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(8 + 16 + HTML.length);
    const b = Buffer.concat([
      await fx('speech_10s_1ch.mp4'),
      len,
      Buffer.from('uuid'),
      Buffer.alloc(16, 0x11),
      HTML,
    ]);
    expect((await pipeline('u.mp4', b, 'video/mp4')).scan).toBe('rejected');
  });

  it.fails('new N-2b: HTML inside a WebM CRC-32 element is rejected', async () => {
    const b = growSeg(await fx('speech_10s_1ch.webm'), mkEl([0xbf], HTML));
    expect((await pipeline('c.webm', b, 'audio/webm')).scan).toBe('rejected');
  });

  it.fails('new N-4: a legit 6 kbit/s Opus WebM (ffmpeg libopus) is accepted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-media-' + 'lb-'));
    try {
      const out = path.join(dir, 'lb.webm');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=c=pink:r=48000:d=10:a=0.3',
        '-ac',
        '1',
        '-c:a',
        'libopus',
        '-b:a',
        '6k',
        out,
      ]);
      expect(await pipeline('lb.webm', await readFile(out), 'audio/webm')).toEqual({
        stage: 'download',
        scan: 'clean',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.fails(
    'new N-5: an MP4 whose video track (16 s) outlasts its audio (10 s) is accepted',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'qa-media-' + 'vfr-'));
      try {
        const out = path.join(dir, 'vfr.mp4');
        execFileSync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=gray:s=160x120:r=5:d=16',
          '-f',
          'lavfi',
          '-i',
          'sine=f=440:r=48000:d=10',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '32k',
          out,
        ]);
        expect(await pipeline('vfr.mp4', await readFile(out), 'video/mp4')).toEqual({
          stage: 'download',
          scan: 'clean',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('#274 L-2: clamd on but unreachable or hanging -> quarantined on the final attempt, never clean', async () => {
    if (!existsSync(path.join(root, 'apps/worker/src/media/clamd.ts'))) return;
    const { createClamdScanner } = await imp('apps/worker/src/media/clamd.ts');
    const net = await import('node:net');
    const hang = net.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as { port: number }).port;
    try {
      for (const av of [
        createClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }),
        createClamdScanner({ host: '127.0.0.1', port, timeoutMs: 500 }),
      ]) {
        const body = await fx('speech_10s_1ch.webm');
        let status: string | null = null;
        const deps = {
          findUpload: async () => ({
            id: w.org,
            key: 'k',
            mimeType: 'audio/webm',
            scanStatus: 'pending',
          }),
          setScanStatus: async (_o: string, _i: string, s: string) => void (status = s),
          source: () => ({
            size: async () => body.length,
            body: async () => (await import('node:stream')).Readable.from([body]),
          }),
          probe: w.probe,
          antivirus: av,
          tmpRoot,
        };
        const job = {
          kind: 'process_upload',
          organizationId: w.org,
          subjectType: 'upload',
          subjectId: w.org,
          consentAttestationId: w.org,
        };
        await expect(
          w.scan.processUploadScan(job, deps, { isFinalAttempt: false }),
        ).rejects.toThrow();
        expect(status).toBeNull();
        const out = await w.scan.processUploadScan(job, deps, { isFinalAttempt: true });
        expect(out.status).toBe('quarantined');
        expect(status).toBe('quarantined');
      }
    } finally {
      hang.close();
    }
  });

  it('bucket is private (policy + ACL) via @meetops/storage verifyBucketPrivate', async () => {
    const svc = await mb.storageService();
    expect((await svc.verifyBucketPrivate()).status).toBe('private');
  });

  describe('chunked recording session (per-chunk sha256)', () => {
    const split = (b: Buffer, n: number) => {
      const size = Math.ceil(b.length / n);
      return Array.from({ length: n }, (_, i) => b.subarray(i * size, (i + 1) * size));
    };
    const start = async () =>
      (
        await w.owner.post(`/orgs/${w.org}/recording-sessions`, {
          mimeType: 'audio/webm',
          startedAt: new Date().toISOString(),
          source: 'tab',
          meetingId: w.meetingId,
          consent: consent(),
        })
      ).json().sessionId as string;
    const sign = async (id: string, seq: number, sizeBytes: number, sha256: string) =>
      w.owner.post(`/recording-sessions/${id}/chunks`, { seq, sizeBytes, sha256 });
    const putChunk = async (id: string, seq: number, c: Buffer, claimedSha = sha256Hex(c)) => {
      const r = await sign(id, seq, c.length, claimedSha);
      expect(r.statusCode).toBe(200);
      const u = r.json().upload;
      return (
        await fetch(String(u.url), { method: 'PUT', headers: u.headers, body: new Uint8Array(c) })
      ).status;
    };
    const complete = (id: string, body: object) =>
      w.owner.post(`/recording-sessions/${id}/complete`, body);
    const assemble = async (id: string, n: number) => {
      const s = await w.sessions.findById(w.org, id);
      const parts: Buffer[] = [];
      for (let i = 0; i < n; i++) parts.push(await mb.getBuffer(String(s.chunks.get(i).key)));
      return Buffer.concat(parts);
    };

    it('out-of-order chunk upload completes; assembled object is byte-identical and scans clean', async () => {
      const src = await fx('speech_10s_1ch.webm');
      const ch = split(src, 4);
      const id = await start();
      for (const seq of [3, 1, 0, 2]) expect(await putChunk(id, seq, ch[seq]!)).toBe(200);
      const r = await complete(id, {
        chunkCount: 4,
        durationMs: 10_000,
        chunks: ch.map((c, seq) => ({ seq, sha256: sha256Hex(c), sizeBytes: c.length })),
      });
      expect(r.statusCode).toBe(202);
      const all = await assemble(id, 4);
      expect(all.equals(src)).toBe(true);
      const key = `organizations/${w.org}/recording-sessions/${id}/assembled`;
      await mb.putBuffer(key, all, 'audio/webm');
      const probe = w.probe;
      const scanMod = await imp('apps/worker/src/media/upload-scan.ts');
      expect(
        await scanMod.scanUploadObject(mb.source(key), 'audio/webm', probe, { tmpRoot }),
      ).toEqual({ verdict: 'clean' });
      expect(await readdir(tmpRoot)).toEqual([]);
    });

    it('a chunk with a deliberately wrong checksum is rejected by storage and complete refuses the session', async () => {
      const ch = split(await fx('speech_10s_1ch.webm'), 3);
      const id = await start();
      expect(await putChunk(id, 0, ch[0]!)).toBe(200);
      expect(await putChunk(id, 1, ch[1]!, sha256Hex(Buffer.from('not the chunk')))).toBe(400);
      expect(await putChunk(id, 2, ch[2]!)).toBe(200);
      const r = await complete(id, { chunkCount: 3, durationMs: 10_000 });
      expect(r.statusCode).toBe(409);
      expect(r.body).not.toContain(w.org + '/recording-sessions'); // no object keys in error bodies
    });

    it('complete with a chunk list whose checksum differs from the signed one -> 400', async () => {
      const ch = split(await fx('speech_10s_1ch.webm'), 2);
      const id = await start();
      for (const [seq, c] of ch.entries()) expect(await putChunk(id, seq, c)).toBe(200);
      const r = await complete(id, {
        chunkCount: 2,
        durationMs: 10_000,
        chunks: [
          { seq: 0, sha256: sha256Hex(ch[0]!) },
          { seq: 1, sha256: 'f'.repeat(64) },
        ],
      });
      expect(r.statusCode).toBe(400);
    });

    it('duplicate chunk: re-signing a seq replaces it; listing a seq twice -> 400', async () => {
      const ch = split(await fx('speech_10s_1ch.webm'), 2);
      const id = await start();
      expect(await putChunk(id, 0, ch[0]!)).toBe(200);
      expect(await putChunk(id, 0, ch[0]!)).toBe(200);
      expect(await putChunk(id, 1, ch[1]!)).toBe(200);
      const dup = await complete(id, {
        chunkCount: 2,
        durationMs: 10_000,
        chunks: [
          { seq: 0, sha256: sha256Hex(ch[0]!) },
          { seq: 0, sha256: sha256Hex(ch[0]!) },
        ],
      });
      expect(dup.statusCode).toBe(400);
      expect((await complete(id, { chunkCount: 2, durationMs: 10_000 })).statusCode).toBe(202);
    });

    it('missing chunks: a gap in seq -> 400; signed but never uploaded -> 409', async () => {
      const ch = split(await fx('speech_10s_1ch.webm'), 3);
      const gap = await start();
      expect(await putChunk(gap, 0, ch[0]!)).toBe(200);
      expect(await putChunk(gap, 2, ch[2]!)).toBe(200);
      expect((await complete(gap, { chunkCount: 2, durationMs: 10_000 })).statusCode).toBe(400);
      const never = await start();
      expect(await putChunk(never, 0, ch[0]!)).toBe(200);
      expect((await sign(never, 1, ch[1]!.length, sha256Hex(ch[1]!))).statusCode).toBe(200);
      expect((await complete(never, { chunkCount: 2, durationMs: 10_000 })).statusCode).toBe(409);
    });
  });

  describe.skipIf(!LARGE)('large fixtures (QA_MEDIA_LARGE=1)', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'qa-media-large-'));
    });
    afterAll(async () => rm(dir, { recursive: true, force: true }));
    const gen = (out: string, secs: number, args: string[]) =>
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-threads',
        '1',
        '-f',
        'lavfi',
        '-i',
        `anoisesrc=c=pink:r=48000:d=${secs}:a=0.4`,
        '-af',
        'bandpass=f=700:w=300',
        '-ac',
        '2',
        ...args,
        path.join(dir, out),
      ]);
    it.each([
      ['speech_120s_2ch.webm', 120, ['-c:a', 'libopus', '-b:a', '24k'], 'audio/webm'],
      ['speech_120s_2ch.mp3', 120, ['-c:a', 'libmp3lame', '-b:a', '32k'], 'audio/mpeg'],
      ['speech_1800s_2ch.webm', 1800, ['-c:a', 'libopus', '-b:a', '16k'], 'audio/webm'],
      ['speech_1800s_2ch.m4a', 1800, ['-c:a', 'aac', '-b:a', '32k'], 'audio/mp4'],
    ] as const)(
      '%s -> clean end to end',
      async (n, secs, args, mime) => {
        gen(n, secs, [...args]);
        expect(await pipeline(n, await readFile(path.join(dir, n)), mime)).toEqual({
          stage: 'download',
          scan: 'clean',
        });
      },
      600_000,
    );
  });

  it('no secrets, object keys or media bytes in logs; no unhandled rejections; no temp files', async () => {
    const all = logged.join('');
    for (const s of mb.secrets) expect(all.includes(s)).toBe(false);
    expect(all).not.toContain('<script>');
    expect(all).not.toMatch(/organizations\/[0-9a-f-]{36}\/(uploads|recording-sessions)\//);
    expect(all).not.toContain('\u001a\u0045\u00df\u00a3'); // EBML magic
    expect(unhandled).toEqual([]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

const HTML = Buffer.from('<html><script>alert(1)</script></html>');

/**
 * Hide HTML inside the WebM Segment: as a Void (0xEC) element, or as raw bytes after the last Cluster with the
 * known-size Segment grown to cover them.
 */
function webmWithTail(src: Buffer, asVoid: boolean): Buffer {
  const tail = asVoid ? Buffer.concat([Buffer.from([0xec, 0x80 | HTML.length]), HTML]) : HTML;
  const b = Buffer.from(src);
  const i = b.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  const len = 9 - b[i + 4]!.toString(2).length;
  let v = 0n;
  for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(b[i + 4 + k]!);
  const mask = (1n << BigInt(7 * len)) - 1n;
  let nv = ((v & mask) + BigInt(tail.length)) | (1n << BigInt(7 * len));
  for (let k = len - 1; k >= 0; k--) {
    b[i + 4 + k] = Number(nv & 0xffn);
    nv >>= 8n;
  }
  return Buffer.concat([b, tail]);
}

/** Minimal 64-bit ELF header (no code): enough for magic-byte checks. */
function elf(): Buffer {
  const b = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(b);
  return b;
}

/** Overwrite the Segment Info Duration (EBML 0x4489) float, in ms. */
function forgeWebmDuration(src: Buffer, ms: number): Buffer {
  const b = Buffer.from(src);
  const i = b.indexOf(Buffer.from([0x44, 0x89]));
  const size = b[i + 2]! & 0x7f;
  if (size === 8) b.writeDoubleBE(ms, i + 3);
  else b.writeFloatBE(ms, i + 3);
  return b;
}
