import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

function dist(indexHtml: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-size-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-AbCd1234.js'), 'console.log("app");\n');
  for (const [file, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, 'assets', file)), { recursive: true });
    writeFileSync(join(dir, 'assets', file), body);
  }
  writeFileSync(join(dir, 'index.html'), indexHtml);
  return dir;
}

const entry = '<script type="module" crossorigin src="/assets/index-AbCd1234.js"></script>';

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

describe('check-bundle-size missing or empty initial JS', () => {
  it('fails when the entry script index.html loads is missing from dist', () => {
    const r = run(dist('<script type="module" src="/assets/index-Gone1234.js"></script>'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html loads assets/index-Gone1234.js, which is missing');
  });

  it('fails when a modulepreload listed in index.html is missing from dist', () => {
    const r = run(dist(`${entry}<link rel="modulepreload" href="/assets/react-Gone1234.js">`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html loads assets/react-Gone1234.js, which is missing');
  });

  it('fails when initial JS totals 0 bytes', () => {
    const r = run(
      dist('<script type="module" src="/assets/index-Empty123.js"></script>', {
        'index-Empty123.js': '',
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('initial JS totals 0 bytes');
  });
});

describe('check-bundle-size nested assets folders', () => {
  it('counts chunks in nested folders under dist/assets', () => {
    const r = spawnSync(
      process.execPath,
      [script, '--json', '--dist', dist(entry, { 'js/lazy/route-AbCd1234.js': 'export {};\n' })],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { rows: { file: string; name: string }[] };
    expect(out.rows).toContainEqual(
      expect.objectContaining({ file: 'js/lazy/route-AbCd1234.js', name: 'route' }),
    );
  });

  it('fails when a nested chunk is over budget', () => {
    // Random bytes do not compress: ~45 kB gzip, over the 25 kB budget for other chunks.
    const big = randomBytes(45 * 1024).toString('base64');
    const r = run(dist(entry, { 'js/lazy/route-AbCd1234.js': big }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('js/lazy/route-AbCd1234.js:');
  });

  it('accepts an entry script and preload that live in a nested folder', () => {
    const r = run(
      dist(
        '<script type="module" src="/assets/js/index-Nest1234.js"></script>' +
          '<link rel="modulepreload" href="/assets/js/vendor/react-Nest1234.js">',
        {
          'js/index-Nest1234.js': 'console.log(1);\n',
          'js/vendor/react-Nest1234.js': 'export {};\n',
        },
      ),
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
