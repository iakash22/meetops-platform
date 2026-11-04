import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the security overrides from #364 (RE-03 closed on node-forge 1.4.2), #367 (decode-uri-component) and
 * #395 (ajv, esbuild): they must stay in the root package.json and the committed lockfile must resolve them.
 * Read-only: nothing here runs pnpm or writes the lockfile.
 */
const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as {
  pnpm?: { overrides?: Record<string, string>; patchedDependencies?: Record<string, string> };
};
const lock = readFileSync(root('pnpm-lock.yaml'), 'utf8');

const GUARDED: Record<string, string> = {
  'node-forge@<1.4.2': '1.4.2', // #364 (RE-03)
  'query-string@7>decode-uri-component': '^0.5.1', // #367
  'ajv@>=8.0.0 <8.18.0': '^8.18.0', // #395
  'esbuild@<0.28.1': '^0.28.1', // #395
};

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
/** Every version of `name` in the lockfile `packages:` / `snapshots:` keys. */
const resolved = (name: string) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\/@]/g, '\\$&');
  const re = new RegExp(`^ {2}'?${esc}@(\\d+\\.\\d+\\.\\d+)[^:]*:`, 'gm');
  return [...new Set([...lock.matchAll(re)].map((m) => m[1] ?? ''))];
};
const lockOverrides = () => {
  const block = /^overrides:\n((?: {2}.+\n)+)/m.exec(lock)?.[1] ?? '';
  return Object.fromEntries(
    block
      .trimEnd()
      .split('\n')
      .map((l) => {
        const m = /^ {2}'?(.+?)'?: (.+)$/.exec(l);
        return [m?.[1] ?? '', m?.[2] ?? ''];
      }),
  );
};

describe('pnpm overrides guard (#364, #367, #395)', () => {
  it.each(Object.entries(GUARDED))('root package.json keeps %s -> %s', (k, v) => {
    expect(pkg.pnpm?.overrides?.[k]).toBe(v);
  });
  it('#367 keeps the query-string@7.1.3 patch', () => {
    expect(pkg.pnpm?.patchedDependencies?.['query-string@7.1.3']).toBe(
      'patches/query-string@7.1.3.patch',
    );
  });
  it('the lockfile records the same overrides as package.json', () => {
    expect(lockOverrides()).toEqual(pkg.pnpm?.overrides);
  });
  it('node-forge resolves only to >=1.4.2', () => {
    const v = resolved('node-forge');
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(cmp(x, '1.4.2'), x).toBeGreaterThanOrEqual(0);
  });
  it('decode-uri-component resolves only to >=0.5.1', () => {
    const v = resolved('decode-uri-component');
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(cmp(x, '0.5.1'), x).toBeGreaterThanOrEqual(0);
  });
  it('no ajv 8.x below 8.18.0', () => {
    const v = resolved('ajv').filter((x) => x.startsWith('8.'));
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(cmp(x, '8.18.0'), x).toBeGreaterThanOrEqual(0);
  });
  it('esbuild resolves only to >=0.28.1', () => {
    const v = resolved('esbuild');
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(cmp(x, '0.28.1'), x).toBeGreaterThanOrEqual(0);
  });
});
