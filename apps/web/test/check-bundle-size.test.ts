import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-bundle-size.mjs',
);
const dirs: string[] = [];

function dist(indexHtml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-size-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-AbCd1234.js'), 'console.log("app");\n');
  writeFileSync(join(dir, 'index.html'), indexHtml);
  return dir;
}

function run(dir: string) {
  return spawnSync(process.execPath, [script, '--dist', dir], { encoding: 'utf8' });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-bundle-size initial JS', () => {
  it('passes when index.html loads its entry script', () => {
    const r = run(
      dist('<script type="module" crossorigin src="/assets/index-AbCd1234.js"></script>'),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Bundle budget OK');
  });

  it('fails with a clear error when index.html has no entry script', () => {
    const r = run(dist('<html><head></head><body><div id="root"></div></body></html>'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html has no entry <script');
  });

  it('does not count a modulepreload alone as the entry script', () => {
    const r = run(dist('<link rel="modulepreload" crossorigin href="/assets/index-AbCd1234.js">'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html has no entry <script');
  });
});
