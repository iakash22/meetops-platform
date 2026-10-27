import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Reader } from 'maxmind';
import {
  GEOIP_UPDATE_CRON,
  MmdbUpdateError,
  assertAllowedUrl,
  expandUrl,
  loadMmdbUpdaterConfig,
  nodeHttpsGet,
  runMmdbUpdate,
  scheduleMmdbUpdate,
  updateMmdb,
  type HttpsGet,
  type MmdbUpdaterConfig,
} from '../src/geoip/mmdb-updater.js';

/** Fictional City fixture from apps/api (provenance: apps/api/test/fixtures/geoip/generate-fixture.py). */
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../api/test/fixtures/geoip/test-city.mmdb', import.meta.url)),
);
const OLD = Buffer.from('old-but-valid-placeholder');
const HOST = 'download.db-ip.com';

let dir: string;
let cfg: MmdbUpdaterConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geoip-upd-'));
  cfg = {
    url: `https://${HOST}/free/dbip-city-lite-{YYYY}-{MM}.mmdb`,
    allowedHosts: [HOST],
    dbPath: join(dir, 'city.mmdb'),
    maxBytes: 1024 * 1024,
    testIps: ['81.2.69.142'],
    timeoutMs: 5000,
  };
  writeFileSync(cfg.dbPath, OLD);
  return () => rmSync(dir, { recursive: true, force: true });
});

const response = (
  body: Buffer | Readable,
  statusCode = 200,
  headers: Record<string, string> = {},
) =>
  Object.assign(body instanceof Readable ? body : Readable.from([body]), { statusCode, headers });
const serve = (
  map: Record<string, () => ReturnType<typeof response>>,
): HttpsGet & { urls: string[] } => {
  const urls: string[] = [];
  const f = (async (u: URL) => {
    urls.push(u.toString());
    const h = map[u.pathname];
    if (!h) return response(Buffer.alloc(0), 404);
    return h();
  }) as HttpsGet & { urls: string[] };
  f.urls = urls;
  return f;
};
const MONTH = () => new Date(Date.UTC(2026, 9, 28));
const PATH = '/free/dbip-city-lite-2026-10.mmdb';
const untouched = () => {
  expect(readFileSync(cfg.dbPath)).toEqual(OLD);
  expect(readdirSync(dir).sort()).toEqual(['city.mmdb']);
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof MmdbUpdateError ? e.code : String(e)),
  );

describe('URL rules', () => {
  it('https only, exact allowlisted host, no credentials; month template', () => {
    expect(() => assertAllowedUrl(`http://${HOST}/x`, [HOST])).toThrow('not_https');
    expect(() => assertAllowedUrl('https://evil.example/x', [HOST])).toThrow('host_not_allowed');
    expect(() => assertAllowedUrl(`https://${HOST}.evil.example/x`, [HOST])).toThrow(
      'host_not_allowed',
    );
    expect(() => assertAllowedUrl(`https://u:p@${HOST}/x`, [HOST])).toThrow('host_not_allowed');
    expect(() => assertAllowedUrl('not a url', [HOST])).toThrow('not_https');
    expect(assertAllowedUrl(`https://${HOST.toUpperCase()}/x`, [HOST]).hostname).toBe(HOST);
    expect(expandUrl('a-{YYYY}-{MM}.mmdb.gz', MONTH())).toBe('a-2026-10.mmdb.gz');
  });
  it('config: off unless GEOIP_UPDATE_URL and GEOIP_DB_PATH; bad URL fails closed at startup', () => {
    expect(loadMmdbUpdaterConfig({})).toBeUndefined();
    expect(loadMmdbUpdaterConfig({ GEOIP_UPDATE_URL: `https://${HOST}/x` })).toBeUndefined();
    expect(() =>
      loadMmdbUpdaterConfig({ GEOIP_UPDATE_URL: `http://${HOST}/x`, GEOIP_DB_PATH: '/tmp/x' }),
    ).toThrow('not_https');
    expect(() =>
      loadMmdbUpdaterConfig({
        GEOIP_UPDATE_URL: 'https://mirror.example/x',
        GEOIP_DB_PATH: '/tmp/x',
      }),
    ).toThrow('host_not_allowed');
    const c = loadMmdbUpdaterConfig({
      GEOIP_UPDATE_URL: `https://${HOST}/free/dbip-city-lite-{YYYY}-{MM}.mmdb.gz`,
      GEOIP_DB_PATH: '/data/city.mmdb',
    });
    expect(c).toMatchObject({ allowedHosts: [HOST], maxBytes: 256 * 1024 * 1024 });
  });
  it('schedules monthly in UTC (idempotent scheduler id)', async () => {
    const q = { upsertJobScheduler: vi.fn(async () => undefined) };
    await scheduleMmdbUpdate(q);
    expect(q.upsertJobScheduler).toHaveBeenCalledWith(
      'geoip.mmdb-update.monthly',
      { pattern: GEOIP_UPDATE_CRON, tz: 'UTC' },
      expect.objectContaining({ name: 'update' }),
    );
  });
});

describe('updateMmdb (mocked transport)', () => {
  it('a redirect is refused and never followed; current file kept', async () => {
    const get = serve({
      [PATH]: () => response(Buffer.alloc(0), 302, { location: `https://${HOST}/elsewhere` }),
    });
    expect(await code(updateMmdb(cfg, { get, now: MONTH }))).toBe('redirect_refused');
    expect(get.urls).toEqual([`https://${HOST}${PATH}`]);
    untouched();
  });
  it('non-200 fails; current kept', async () => {
    expect(await code(updateMmdb(cfg, { get: serve({}), now: MONTH }))).toBe('http_status');
    untouched();
  });
  it('oversize by Content-Length is aborted before reading', async () => {
    const get = serve({
      [PATH]: () => response(Buffer.alloc(10), 200, { 'content-length': String(cfg.maxBytes + 1) }),
    });
    expect(await code(updateMmdb(cfg, { get, now: MONTH }))).toBe('too_large');
    untouched();
  });
  it('oversize while streaming (no or lying Content-Length) is aborted mid-stream', async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        this.push(produced > 50 * 1024 * 1024 ? null : randomBytes(64 * 1024));
      },
    });
    const get = serve({ [PATH]: () => response(endless, 200, { 'content-length': '100' }) });
    expect(await code(updateMmdb(cfg, { get, now: MONTH }))).toBe('too_large');
    expect(produced).toBeLessThan(4 * 1024 * 1024);
    untouched();
  });
  it('gzip bomb: decompressed size is capped too', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(cfg.maxBytes);
    const get = serve({ [`${PATH}.gz`]: () => response(bomb) });
    expect(await code(updateMmdb({ ...cfg, url: `${cfg.url}.gz` }, { get, now: MONTH }))).toBe(
      'too_large',
    );
    untouched();
  });
  it('a corrupt file is rejected (maxmind cannot open it); current kept', async () => {
    const get = serve({ [PATH]: () => response(randomBytes(4096)) });
    expect(await code(updateMmdb(cfg, { get, now: MONTH }))).toBe('unreadable');
    untouched();
    const gz = serve({ [`${PATH}.gz`]: () => response(Buffer.from('not gzip at all')) });
    expect(await code(updateMmdb({ ...cfg, url: `${cfg.url}.gz` }, { get: gz, now: MONTH }))).toBe(
      'unreadable',
    );
    untouched();
  });
  it('a valid mmdb whose test lookups all miss is rejected', async () => {
    const get = serve({ [PATH]: () => response(FIXTURE) });
    expect(await code(updateMmdb({ ...cfg, testIps: ['192.0.2.1'] }, { get, now: MONTH }))).toBe(
      'lookups_failed',
    );
    untouched();
  });
  it('checksum: mismatch rejected, malformed rejected, match accepted', async () => {
    const sha = createHash('sha256').update(FIXTURE).digest('hex');
    const withSha = (body: string) =>
      serve({
        [PATH]: () => response(FIXTURE),
        [`${PATH}.sha256`]: () => response(Buffer.from(body)),
      });
    const c2 = { ...cfg, sha256Url: `${cfg.url}.sha256` };
    expect(await code(updateMmdb(c2, { get: withSha('0'.repeat(64)), now: MONTH }))).toBe(
      'checksum_mismatch',
    );
    untouched();
    expect(await code(updateMmdb(c2, { get: withSha('<html>nope'), now: MONTH }))).toBe(
      'checksum_invalid',
    );
    untouched();
    const r = await updateMmdb(c2, { get: withSha(`${sha}  city.mmdb\n`), now: MONTH });
    expect(r).toMatchObject({ updated: true, keptPrevious: true });
  });
  it('success: swaps in the verified file, keeps the last good copy, leaves no temp files', async () => {
    const get = serve({ [`${PATH}.gz`]: () => response(gzipSync(FIXTURE)) });
    const r = await updateMmdb({ ...cfg, url: `${cfg.url}.gz` }, { get, now: MONTH });
    expect(r).toMatchObject({ updated: true, bytes: FIXTURE.length, keptPrevious: true });
    expect(readFileSync(cfg.dbPath)).toEqual(FIXTURE);
    expect(readFileSync(`${cfg.dbPath}.prev`)).toEqual(OLD);
    expect(readdirSync(dir).sort()).toEqual(['city.mmdb', 'city.mmdb.prev']);
    // First install (no current file): no .prev.
    rmSync(cfg.dbPath);
    rmSync(`${cfg.dbPath}.prev`);
    const r2 = await updateMmdb({ ...cfg, url: `${cfg.url}.gz` }, { get, now: MONTH });
    expect(r2.keptPrevious).toBe(false);
  });
  it('swap is atomic: concurrent readers always see a complete old or new file', async () => {
    writeFileSync(cfg.dbPath, FIXTURE);
    const other = Buffer.from(FIXTURE);
    const get = serve({ [PATH]: () => response(other) });
    let stop = false;
    let reads = 0;
    const failures: string[] = [];
    const reader = (async () => {
      while (!stop) {
        try {
          const r = new Reader(readFileSync(cfg.dbPath));
          if (!r.get('81.2.69.142')) failures.push('lookup');
        } catch (e) {
          failures.push(String(e));
        }
        reads++;
        await new Promise((res) => setImmediate(res));
      }
    })();
    for (let i = 0; i < 20; i++) await updateMmdb(cfg, { get, now: MONTH });
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
  it('job logs codes only and rethrows; current kept', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const get = serve({ [PATH]: () => response(Buffer.alloc(0), 301, { location: 'https://x' }) });
    await expect(runMmdbUpdate(cfg, log, { get, now: MONTH })).rejects.toBeInstanceOf(
      MmdbUpdateError,
    );
    expect(log.warn).toHaveBeenCalledWith(
      { errCode: 'redirect_refused', errName: 'MmdbUpdateError' },
      expect.any(String),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(dir);
    untouched();
  });
});

/** Real TLS against a throwaway local HTTPS server (self-signed cert made at test time, trusted via `ca` only). */
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(!hasOpenssl)('updateMmdb over local HTTPS', () => {
  let server: Server;
  let base: string;
  let ca: Buffer;
  let certDir: string;
  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'geoip-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        join(certDir, 'k.pem'),
        '-out',
        join(certDir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(join(certDir, 'c.pem'));
    server = createServer({ key: readFileSync(join(certDir, 'k.pem')), cert: ca }, (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/city.mmdb' }).end();
      } else if (req.url === '/city.mmdb') {
        res.writeHead(200, { 'content-length': FIXTURE.length }).end(FIXTURE);
      } else if (req.url === '/big') {
        res.writeHead(200);
        const chunk = Buffer.alloc(256 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 64 * 1024 * 1024 && res.write(chunk)) sent += chunk.length;
          if (sent < 64 * 1024 * 1024) res.once('drain', pump);
          else res.end();
        };
        res.on('error', () => undefined);
        pump();
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(certDir, { recursive: true, force: true });
  });
  const tls = () => nodeHttpsGet({ ca });
  it('downloads, verifies and swaps', async () => {
    const r = await updateMmdb(
      { ...cfg, url: `${base}/city.mmdb`, allowedHosts: ['localhost'] },
      { get: tls() },
    );
    expect(r.updated).toBe(true);
    expect(readFileSync(cfg.dbPath)).toEqual(FIXTURE);
    expect(existsSync(`${cfg.dbPath}.prev`)).toBe(true);
  });
  it('refuses the redirect', async () => {
    expect(
      await code(
        updateMmdb(
          { ...cfg, url: `${base}/redirect`, allowedHosts: ['localhost'] },
          { get: tls() },
        ),
      ),
    ).toBe('redirect_refused');
    untouched();
  });
  it('aborts an oversize stream', async () => {
    expect(
      await code(
        updateMmdb({ ...cfg, url: `${base}/big`, allowedHosts: ['localhost'] }, { get: tls() }),
      ),
    ).toBe('too_large');
    untouched();
  });
  it('rejects an untrusted certificate (no ca)', async () => {
    expect(
      await code(updateMmdb({ ...cfg, url: `${base}/city.mmdb`, allowedHosts: ['localhost'] })),
    ).toBe('network');
    untouched();
  });
});
