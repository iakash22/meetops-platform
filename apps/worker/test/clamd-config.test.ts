import { readFileSync } from 'node:fs';
import { MAX_MEDIA_BYTES } from '@meetops/contracts';
import { describe, expect, it } from 'vitest';
import { CLAMD_MAX_SCAN_TIME_MS, CLAMD_SCAN_TIMEOUT_MS } from '../src/media/clamd.js';

/**
 * MAL-1 / ADR-018: the clamd sidecar config is part of the upload contract. A full-size upload
 * (MAX_MEDIA_BYTES) must be scanned in full, not refused or partly scanned at a clamd limit.
 */
const repo = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), 'utf8');

/** clamd.conf as `Key value` pairs (comments and blank lines dropped; a repeated key is an error). */
function parseConf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) throw new Error(`bad clamd.conf line: ${line}`);
    if (out.has(m[1]!)) throw new Error(`duplicate clamd.conf key: ${m[1]}`);
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** clamd size syntax: plain bytes, or a K/M suffix (KiB/MiB, as clamconf prints them). */
function clamdBytes(v: string): number {
  const m = /^(\d+)([KkMm]?)$/.exec(v);
  if (!m) throw new Error(`bad clamd size: ${v}`);
  const mult = { '': 1, k: 1024, m: 1024 * 1024 }[m[2]!.toLowerCase() as '' | 'k' | 'm'];
  return Number(m[1]) * mult;
}

const clamd = parseConf(read('infra/clamav/clamd.conf'));
const freshclam = parseConf(read('infra/clamav/freshclam.conf'));
const compose = read('infra/compose/compose.app.yml');
const composeDev = read('infra/compose/compose.dev.yml');
/** A service block of compose.app.yml (up to the next top-level service or key). */
const serviceBlock = (name: string) =>
  new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n(?: {2}(?:#.*\\n {2})*[a-z-]+:|[a-z]+:)\\n`).exec(
    compose,
  )?.[1] ?? '';
const clamavService = serviceBlock('clamav');
const freshclamService = serviceBlock('clamav-freshclam');
const workerService = serviceBlock('worker');

describe('clamd sidecar config (MAL-1, ADR-018)', () => {
  it('parses 1400M as 1_468_006_400 bytes (clamd M = MiB)', () => {
    expect(clamdBytes('1400M')).toBe(1_468_006_400);
  });

  it.each(['StreamMaxLength', 'MaxFileSize', 'MaxScanSize'])(
    '%s is 1400M: >= MAX_MEDIA_BYTES and < 2 GB',
    (key) => {
      const v = clamd.get(key);
      expect(v).toBe('1400M');
      const bytes = clamdBytes(v!);
      expect(bytes).toBeGreaterThanOrEqual(MAX_MEDIA_BYTES);
      expect(bytes).toBeLessThan(2 ** 31);
    },
  );

  it('fails closed on limits and keeps the scan time above a 1.4 GB scan', () => {
    expect(clamd.get('AlertExceedsMax')).toBe('yes');
    expect(Number(clamd.get('MaxScanTime'))).toBeGreaterThanOrEqual(600_000);
  });

  it('keeps serving scans during a signature reload (paired with mem_limit 7g: 4g engines + 3g tmpfs)', () => {
    expect(clamd.get('ConcurrentDatabaseReload')).toBe('yes');
    expect(clamavService).toMatch(/\n {4}mem_limit: 7g\n/);
  });

  it('listens where the worker and the image healthcheck expect it', () => {
    expect(clamd.get('TCPSocket')).toBe('3310');
    expect(clamd.get('LocalSocket')).toBe('/tmp/clamd.sock');
  });

  it('pins the ClamAV image by version and digest', () => {
    expect(clamavService).toMatch(/\n {4}image: clamav\/clamav:1\.4\.\d+@sha256:[0-9a-f]{64}\n/);
  });

  it('updates signatures daily in clamav-freshclam and mounts each config read-only where used', () => {
    expect(freshclam.get('Checks')).toBe('1');
    expect(freshclamService).toContain("'--checks=1'");
    expect(freshclamService).toContain('../clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro');
    expect(clamavService).toContain('../clamav/clamd.conf:/etc/clamav/clamd.conf:ro');
    // Both share the signature volume; clamd picks updates up itself (MAL-1b).
    expect(freshclamService).toContain('- clamav-db:/var/lib/clamav');
    expect(clamavService).toContain('- clamav-db:/var/lib/clamav');
    expect(Number(clamd.get('SelfCheck'))).toBeGreaterThan(0);
    expect(Number(clamd.get('SelfCheck'))).toBeLessThanOrEqual(3600);
  });

  it('splits freshclam from clamd: each container runs one daemon, same pinned image (MAL-1b)', () => {
    expect(clamavService).toMatch(/\n {4}entrypoint: \['clamd', '--foreground'\]\n/);
    expect(freshclamService).toMatch(/\n {4}entrypoint: \['freshclam', '--daemon', /);
    const image = (b: string) => /\n {4}image: (\S+)\n/.exec(b)?.[1];
    expect(image(freshclamService)).toBeDefined();
    expect(image(freshclamService)).toBe(image(clamavService));
    // freshclam cannot reach clamd, so it must not try to notify it.
    expect(freshclam.has('NotifyClamd')).toBe(false);
  });

  it('publishes no host port: clamd (unauthenticated) is reachable only on the compose networks (#377 M7)', () => {
    expect(clamavService).not.toBe('');
    expect(clamavService).not.toMatch(/^ {4}(ports|expose):/m);
    expect(clamavService).not.toMatch(/^ {4}network_mode:/m);
  });

  it('puts clamd only on the internal clamav-internal network, shared with the worker alone (MAL-1b)', () => {
    // No `default`: clamd has no egress and no other service can send it SHUTDOWN.
    expect(clamavService).toMatch(/\n {4}networks: \[clamav-internal\]\n/);
    expect(composeDev).toMatch(/\n {2}clamav-internal:\n {4}internal: true\n/);
    expect(workerService).toMatch(/\n {4}networks: \[[^\]\n]*\bclamav-internal\b[^\]\n]*\]\n/);
    // Only the worker and clamav join it, in either compose file.
    const members = [
      ...`${compose}\n${composeDev}`.matchAll(/^ {4}networks: \[([^\]\n]*)\]$/gm),
    ].filter((m) => m[1]!.split(',').some((n) => n.trim() === 'clamav-internal'));
    expect(members).toHaveLength(2);
    expect(`${compose}\n${composeDev}`).not.toMatch(/^ {6}- clamav-internal$/m);
    // freshclam keeps egress for database.clamav.net but has no route to clamd.
    expect(freshclamService).toMatch(/\n {4}networks: \[default\]\n/);
    expect(freshclamService).not.toMatch(/^ {4}(ports|expose|network_mode):/m);
  });

  it.each([
    ['clamav', () => clamavService],
    ['clamav-freshclam', () => freshclamService],
  ])('%s runs as the clamav user with no capabilities (MAL-1b)', (_name, block) => {
    const b = block();
    expect(b).not.toBe('');
    expect(b).toMatch(/\n {4}user: clamav\n/);
    expect(b).toMatch(/\n {4}cap_drop: \[ALL\]\n/);
    expect(b).not.toMatch(/^ {4}(cap_add|privileged):/m);
    expect(b).toMatch(/\n {6}- no-new-privileges:true\n/);
    // The image's /init needs root (chown, install) and would also start freshclam in clamd.
    expect(b).toMatch(/\n {4}entrypoint: \[/);
    expect(b).not.toContain('/init');
  });

  it('logs to stdout: no log file paths that the non-root daemons could not create (MAL-1b)', () => {
    expect(clamd.has('LogFile')).toBe(false);
    expect(freshclam.has('UpdateLogFile')).toBe(false);
  });

  it('wires the worker to the sidecar', () => {
    expect(compose).toMatch(/\n {6}CLAMD_HOST: clamav\n/);
    expect(compose).toMatch(/\n {6}UPLOAD_SCAN_CLAMAV: \$\{UPLOAD_SCAN_CLAMAV:-false\}\n/);
  });

  // #377/#379 follow-ups (disk fill, pinned limits, MAL-2 timeout alignment).
  it('caps temp disk: TemporaryDirectory on a size-capped tmpfs, read-only root for clamd', () => {
    expect(clamd.get('TemporaryDirectory')).toBe('/tmp');
    expect(clamavService).toMatch(/\n {4}read_only: true\n/);
    expect(clamavService).toMatch(
      /\n {6}- \/tmp:size=3g,uid=100,gid=101,mode=0700,noexec,nosuid,nodev\n/,
    );
  });

  it('tmpfs fits one scan per thread (stream + extracted data) and MaxThreads matches worker concurrency', () => {
    const threads = Number(clamd.get('MaxThreads'));
    const concurrency = /\n {6}MEDIA_WORKER_CONCURRENCY: (\d+)\n/.exec(workerService)?.[1];
    expect(threads).toBe(1);
    expect(Number(concurrency)).toBe(threads);
    const perScan =
      clamdBytes(clamd.get('StreamMaxLength')!) + clamdBytes(clamd.get('MaxScanSize')!);
    expect(threads * perScan).toBeLessThanOrEqual(3 * 1024 ** 3);
  });

  it.each([
    ['MaxRecursion', '17'],
    ['MaxFiles', '10000'],
    ['MaxEmbeddedPE', '40M'],
    ['PCREMaxFileSize', '100M'],
    ['MaxConnectionQueueLength', '4'],
  ])('pins %s = %s', (key, value) => {
    expect(clamd.get(key)).toBe(value);
  });

  it('worker scan timeout is above clamd MaxScanTime, so clamd answers first (MAL-2)', () => {
    expect(Number(clamd.get('MaxScanTime'))).toBe(CLAMD_MAX_SCAN_TIME_MS);
    expect(CLAMD_SCAN_TIMEOUT_MS).toBeGreaterThan(CLAMD_MAX_SCAN_TIME_MS);
    expect(CLAMD_SCAN_TIMEOUT_MS - CLAMD_MAX_SCAN_TIME_MS).toBeLessThanOrEqual(60_000);
  });
});
