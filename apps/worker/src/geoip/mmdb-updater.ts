import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Reader, type CityResponse } from 'maxmind';
import type { SchedulerQueue } from '../privacy/ip-retention.js';

/**
 * ADR-014 monthly GeoIP database updater (DB-IP City Lite, CC BY 4.0 — free, no account, no key).
 *
 * Download: https only, host must be on the allowlist, redirects are never followed, size capped while streaming
 * (compressed and decompressed). Verify: optional SHA-256 (from GEOIP_UPDATE_SHA256_URL, same rules), open with
 * maxmind, database type must be a City database, test lookups must resolve. Swap: the verified file is renamed over
 * GEOIP_DB_PATH (atomic on one filesystem) after the current file is kept as `<path>.prev`. Any failure leaves the
 * current file untouched. No paid provider, no fallback source.
 */
export const GEOIP_UPDATE_QUEUE = 'geoip.mmdb-update';
export const GEOIP_UPDATE_SCHEDULER_ID = 'geoip.mmdb-update.monthly';
/** 04:30 UTC on the 3rd (DB-IP publishes the month's Lite file at the start of the month). */
export const GEOIP_UPDATE_CRON = '30 4 3 * *';
export const DEFAULT_ALLOWED_HOSTS = ['download.db-ip.com'] as const;
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TEST_IPS = ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'] as const;

export interface MmdbUpdaterConfig {
  /** `https://download.db-ip.com/free/dbip-city-lite-{YYYY}-{MM}.mmdb.gz` ({YYYY}/{MM} = current UTC month). */
  url: string;
  /** Optional URL (same template/allowlist rules) whose body starts with the hex SHA-256 of the downloaded file. */
  sha256Url?: string | undefined;
  allowedHosts: readonly string[];
  dbPath: string;
  maxBytes: number;
  testIps: readonly string[];
  /** Socket idle timeout per request. */
  timeoutMs: number;
  /** Overall deadline for the whole run (checksum + download + decompress), against slow-drip responses. */
  totalTimeoutMs: number;
  /** Test-only (local HTTPS server on a random port); never read from env. */
  allowAnyPort?: boolean;
}

export type UpdaterErrorCode =
  | 'not_https'
  | 'host_not_allowed'
  | 'port_not_allowed'
  | 'redirect_refused'
  | 'http_status'
  | 'too_large'
  | 'timeout'
  | 'network'
  | 'checksum_mismatch'
  | 'checksum_invalid'
  | 'unreadable'
  | 'wrong_type'
  | 'lookups_failed';

export class MmdbUpdateError extends Error {
  constructor(readonly code: UpdaterErrorCode) {
    super(`geoip update failed: ${code}`);
    this.name = 'MmdbUpdateError';
  }
}

export type HttpsGet = (
  url: URL,
  opts: { timeoutMs: number },
) => Promise<
  | IncomingMessage
  | (Readable & {
      statusCode?: number;
      headers: Record<string, string | string[] | undefined>;
    })
>;

/** Node https GET: never follows redirects (https.request has no redirect handling), per-request timeout. */
export function nodeHttpsGet(extra: RequestOptions = {}): HttpsGet {
  return (url, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: 'GET', ...extra, timeout: timeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new MmdbUpdateError('timeout')));
      req.on('error', reject);
      req.end();
    });
}

export function expandUrl(template: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return template.replaceAll('{YYYY}', yyyy).replaceAll('{MM}', mm);
}

/**
 * https + exact host allowlist (no wildcards, no credentials) on the default port only: any explicit port (even :443
 * spelled out is normalised away by URL) is refused. `allowAnyPort` exists only for the local-HTTPS test server and
 * cannot be set from the environment.
 */
export function assertAllowedUrl(
  raw: string,
  allowedHosts: readonly string[],
  opts: { allowAnyPort?: boolean } = {},
): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MmdbUpdateError('not_https');
  }
  if (u.protocol !== 'https:') throw new MmdbUpdateError('not_https');
  if (u.username || u.password) throw new MmdbUpdateError('host_not_allowed');
  if (u.port !== '' && !opts.allowAnyPort) throw new MmdbUpdateError('port_not_allowed');
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase()))
    throw new MmdbUpdateError('host_not_allowed');
  return u;
}

function capStream(max: number) {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new MmdbUpdateError('too_large'));
      else cb(null, chunk);
    },
  });
}

async function fetchChecked(
  url: URL,
  cfg: Pick<MmdbUpdaterConfig, 'maxBytes' | 'timeoutMs'>,
  get: HttpsGet,
) {
  let res;
  try {
    res = await get(url, { timeoutMs: cfg.timeoutMs });
  } catch (e) {
    throw e instanceof MmdbUpdateError ? e : new MmdbUpdateError('network');
  }
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    res.resume();
    throw new MmdbUpdateError('redirect_refused');
  }
  if (status !== 200) {
    res.resume();
    throw new MmdbUpdateError('http_status');
  }
  const len = Number(res.headers['content-length']);
  if (Number.isFinite(len) && len > cfg.maxBytes) {
    res.destroy();
    throw new MmdbUpdateError('too_large');
  }
  return res;
}

async function fetchSha256(cfg: MmdbUpdaterConfig, now: Date, get: HttpsGet): Promise<string> {
  const url = assertAllowedUrl(expandUrl(cfg.sha256Url!, now), cfg.allowedHosts, cfg);
  const res = await fetchChecked(url, { maxBytes: 4096, timeoutMs: cfg.timeoutMs }, get);
  const chunks: Buffer[] = [];
  await pipeline(res, capStream(4096), async function* (src) {
    for await (const c of src) chunks.push(c as Buffer);
    yield* [];
  });
  const hex = Buffer.concat(chunks).toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new MmdbUpdateError('checksum_invalid');
  return hex;
}

/** Opens the candidate with maxmind and runs the test lookups. */
export async function verifyMmdb(path: string, testIps: readonly string[]) {
  let reader: Reader<CityResponse>;
  try {
    reader = new Reader<CityResponse>(await readFile(path));
  } catch {
    throw new MmdbUpdateError('unreadable');
  }
  if (!/city/i.test(reader.metadata.databaseType)) throw new MmdbUpdateError('wrong_type');
  let hits = 0;
  for (const ip of testIps) {
    try {
      if (reader.get(ip)?.country?.iso_code) hits++;
    } catch {
      /* counted as a miss */
    }
  }
  if (testIps.length > 0 && hits === 0) throw new MmdbUpdateError('lookups_failed');
  return {
    databaseType: reader.metadata.databaseType,
    buildEpoch: reader.metadata.buildEpoch,
    hits,
  };
}

async function fsyncFile(path: string) {
  // Windows often returns EPERM for fsync on an 'r' handle; open 'r+' when we own the temp file.
  const fh = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await fh.sync();
  } catch (e) {
    // Some Windows volumes still reject FileHandle.sync(); the write stream already flushed to disk.
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return;
    throw e;
  } finally {
    await fh.close();
  }
}

/**
 * Replace `dest` with `src` via rename (atomic on one filesystem). On Windows a concurrent reader can lock `dest`
 * (EPERM/EACCES/EBUSY); retry briefly so a transient lock from AV or a short-lived open does not fail the swap.
 */
async function renameReplace(src: string, dest: string, attempts = 20): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(src, dest);
      return;
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException).code;
      const locked =
        process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!locked || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
  throw last;
}

export interface UpdateResult {
  updated: true;
  bytes: number;
  databaseType: string;
  buildEpoch: Date;
  keptPrevious: boolean;
}

/**
 * One update pass. Streams to a temp file next to dbPath (same filesystem, so rename is atomic), verifies it, keeps
 * the current file as `<dbPath>.prev`, then renames the candidate over dbPath. Throws MmdbUpdateError on any failure;
 * the current file is never modified before verification succeeds and the temp file is always removed.
 */
export async function updateMmdb(
  cfg: MmdbUpdaterConfig,
  deps: { get?: HttpsGet; now?: () => Date } = {},
): Promise<UpdateResult> {
  const rawGet = deps.get ?? nodeHttpsGet();
  // Overall deadline: every response opened in this run is destroyed with `timeout` when it fires, and a pending
  // request rejects. The current file is untouched (the swap only happens after a complete, verified download).
  const open = new Set<{ destroy(e?: Error): void }>();
  let expired = false;
  let onExpire: (() => void) | undefined;
  const timer = setTimeout(() => {
    expired = true;
    for (const r of open) r.destroy(new MmdbUpdateError('timeout'));
    onExpire?.();
  }, cfg.totalTimeoutMs);
  timer.unref?.();
  const get: HttpsGet = async (u, o) => {
    if (expired) throw new MmdbUpdateError('timeout');
    const res = await Promise.race([
      rawGet(u, o),
      new Promise<never>((_r, rej) => {
        onExpire = () => rej(new MmdbUpdateError('timeout'));
      }),
    ]);
    if (expired) {
      res.destroy();
      throw new MmdbUpdateError('timeout');
    }
    open.add(res);
    return res;
  };
  try {
    return await updateWithin(cfg, get, deps.now);
  } finally {
    clearTimeout(timer);
  }
}

async function updateWithin(
  cfg: MmdbUpdaterConfig,
  get: HttpsGet,
  nowFn?: () => Date,
): Promise<UpdateResult> {
  const now = (nowFn ?? (() => new Date()))();
  const url = assertAllowedUrl(expandUrl(cfg.url, now), cfg.allowedHosts, cfg);
  const expectedSha = cfg.sha256Url ? await fetchSha256(cfg, now, get) : undefined;
  const dir = dirname(cfg.dbPath);
  const tmp = join(dir, `.${basename(cfg.dbPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const res = await fetchChecked(url, cfg, get);
    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const gz = url.pathname.endsWith('.gz');
    const stages: NodeJS.ReadWriteStream[] = [capStream(cfg.maxBytes), tap];
    // Decompressed size is capped too (gzip bomb).
    if (gz) stages.push(createGunzip(), capStream(cfg.maxBytes));
    try {
      await pipeline(
        res,
        ...(stages as [Transform]),
        createWriteStream(tmp, { flags: 'wx', mode: 0o644 }),
      );
    } catch (e) {
      if (e instanceof MmdbUpdateError) throw e;
      throw new MmdbUpdateError(
        gz && e instanceof Error && /zlib|header|unexpected end/i.test(e.message)
          ? 'unreadable'
          : 'network',
      );
    }
    if (expectedSha && hash.digest('hex') !== expectedSha)
      throw new MmdbUpdateError('checksum_mismatch');
    await fsyncFile(tmp);
    const v = await verifyMmdb(tmp, cfg.testIps);
    const bytes = (await stat(tmp)).size;
    let keptPrevious = false;
    try {
      const prevTmp = `${tmp}.prev`;
      await copyFile(cfg.dbPath, prevTmp);
      await renameReplace(prevTmp, `${cfg.dbPath}.prev`);
      keptPrevious = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await renameReplace(tmp, cfg.dbPath);
    return {
      updated: true,
      bytes,
      databaseType: v.databaseType,
      buildEpoch: v.buildEpoch,
      keptPrevious,
    };
  } finally {
    await unlink(tmp).catch(() => undefined);
    await unlink(`${tmp}.prev`).catch(() => undefined);
  }
}

const intIn = (v: string | undefined, def: number, min: number, max: number) =>
  v && /^[0-9]{1,12}$/.test(v) ? Math.min(max, Math.max(min, Number(v))) : def;
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Off unless GEOIP_UPDATE_URL and GEOIP_DB_PATH are both set. GEOIP_UPDATE_ALLOWED_HOSTS (default download.db-ip.com),
 * GEOIP_UPDATE_SHA256_URL, GEOIP_UPDATE_MAX_BYTES (default 256 MiB), GEOIP_UPDATE_TEST_IPS, GEOIP_UPDATE_TIMEOUT_MS (idle), GEOIP_UPDATE_TOTAL_TIMEOUT_MS (overall,
 * default 5 min). Only the default https port is accepted.
 * An invalid URL or host throws at startup (fail closed, never a silent fallback).
 */
export function loadMmdbUpdaterConfig(
  env: NodeJS.ProcessEnv = process.env,
): MmdbUpdaterConfig | undefined {
  const url = env.GEOIP_UPDATE_URL?.trim();
  const dbPath = env.GEOIP_DB_PATH?.trim();
  if (!url || !dbPath) return undefined;
  const allowedHosts = list(env.GEOIP_UPDATE_ALLOWED_HOSTS);
  const cfg: MmdbUpdaterConfig = {
    url,
    sha256Url: env.GEOIP_UPDATE_SHA256_URL?.trim() || undefined,
    allowedHosts: allowedHosts.length ? allowedHosts : [...DEFAULT_ALLOWED_HOSTS],
    dbPath,
    maxBytes: intIn(env.GEOIP_UPDATE_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, 2 * 1024 * 1024 * 1024),
    testIps: list(env.GEOIP_UPDATE_TEST_IPS).length
      ? list(env.GEOIP_UPDATE_TEST_IPS)
      : [...DEFAULT_TEST_IPS],
    timeoutMs: intIn(env.GEOIP_UPDATE_TIMEOUT_MS, 120_000, 1000, 3_600_000),
    totalTimeoutMs: intIn(
      env.GEOIP_UPDATE_TOTAL_TIMEOUT_MS,
      DEFAULT_TOTAL_TIMEOUT_MS,
      5000,
      3_600_000,
    ),
  };
  const probe = new Date();
  assertAllowedUrl(expandUrl(cfg.url, probe), cfg.allowedHosts);
  if (cfg.sha256Url) assertAllowedUrl(expandUrl(cfg.sha256Url, probe), cfg.allowedHosts);
  return cfg;
}

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

/** BullMQ job body. Logs codes and sizes only (no URLs with query strings, no paths). Rethrows for retry. */
export async function runMmdbUpdate(
  cfg: MmdbUpdaterConfig,
  log: Log,
  deps: Parameters<typeof updateMmdb>[1] = {},
) {
  try {
    const r = await updateMmdb(cfg, deps);
    log.info(
      {
        bytes: r.bytes,
        databaseType: r.databaseType,
        buildEpoch: r.buildEpoch.toISOString(),
        keptPrevious: r.keptPrevious,
      },
      'geoip database updated',
    );
    return r;
  } catch (e) {
    log.warn(
      {
        errCode: e instanceof MmdbUpdateError ? e.code : 'unknown',
        errName: e instanceof Error ? e.name : 'unknown',
      },
      'geoip database update failed; current file kept',
    );
    throw e;
  }
}

export async function scheduleMmdbUpdate(queue: SchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    GEOIP_UPDATE_SCHEDULER_ID,
    { pattern: GEOIP_UPDATE_CRON, tz: 'UTC' },
    {
      name: 'update',
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 15 * 60_000 },
        removeOnComplete: 12,
        removeOnFail: 24,
      },
    },
  );
}
