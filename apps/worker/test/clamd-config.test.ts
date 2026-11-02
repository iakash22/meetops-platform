import { readFileSync } from 'node:fs';
import { MAX_MEDIA_BYTES } from '@meetops/contracts';
import { describe, expect, it } from 'vitest';

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
/** The `clamav:` service block of compose.app.yml (up to the next top-level service). */
const clamavService =
  /\n {2}clamav:\n([\s\S]*?)\n {2}(?:#.*\n {2})*[a-z-]+:\n/.exec(compose)?.[1] ?? '';

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

  it('keeps serving scans during a signature reload (paired with mem_limit 4g)', () => {
    expect(clamd.get('ConcurrentDatabaseReload')).toBe('yes');
    expect(clamavService).toMatch(/\n {4}mem_limit: 4g\n/);
  });

  it('listens where the worker and the image healthcheck expect it', () => {
    expect(clamd.get('TCPSocket')).toBe('3310');
    expect(clamd.get('LocalSocket')).toBe('/tmp/clamd.sock');
  });

  it('pins the ClamAV image by version and digest', () => {
    expect(clamavService).toMatch(/\n {4}image: clamav\/clamav:1\.4\.\d+@sha256:[0-9a-f]{64}\n/);
  });

  it('updates signatures daily and mounts both config files read-only', () => {
    expect(freshclam.get('Checks')).toBe('1');
    expect(freshclam.get('NotifyClamd')).toBe('/etc/clamav/clamd.conf');
    expect(clamavService).toMatch(/\n {6}FRESHCLAM_CHECKS: 1\n/);
    expect(clamavService).toContain('../clamav/clamd.conf:/etc/clamav/clamd.conf:ro');
    expect(clamavService).toContain('../clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro');
  });

  it('publishes no host port: clamd (unauthenticated) is reachable only on the compose networks (#377 M7)', () => {
    expect(clamavService).not.toBe('');
    expect(clamavService).not.toMatch(/^ {4}(ports|expose):/m);
    expect(clamavService).not.toMatch(/^ {4}network_mode:/m);
    expect(clamavService).toMatch(/\n {4}networks: \[default, media-internal\]\n/);
  });

  it('wires the worker to the sidecar', () => {
    expect(compose).toMatch(/\n {6}CLAMD_HOST: clamav\n/);
    expect(compose).toMatch(/\n {6}UPLOAD_SCAN_CLAMAV: \$\{UPLOAD_SCAN_CLAMAV:-false\}\n/);
  });
});
