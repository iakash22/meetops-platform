import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss, { type PluginCreator } from 'postcss';
import { describe, expect, it } from 'vitest';

interface PruneModule {
  default: PluginCreator<{ tokens?: Set<string> }>;
  sourceTokens: () => Set<string>;
  selectorClasses: (selector: string) => string[];
  isUsed: (cls: string, tokens: Set<string>) => boolean;
}

// Plain .mjs (loaded by postcss.config.js in Node), so import it untyped and describe its shape here.
const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'postcss-prune-bootstrap.mjs'),
).href;
const {
  default: pruneBootstrap,
  isUsed,
  selectorClasses,
  sourceTokens,
} = (await import(scriptUrl)) as PruneModule;

const BS = '/x/node_modules/bootstrap/dist/css/bootstrap.min.css';

async function run(css: string, tokens: string[], from = BS) {
  const r = await postcss([pruneBootstrap({ tokens: new Set(tokens) })]).process(css, { from });
  return r.css;
}

describe('postcss-prune-bootstrap', () => {
  it('drops Bootstrap rules for unused classes and keeps used ones', async () => {
    const out = await run('.modal{a:1}.p-3{b:2}.carousel .item{c:3}', ['p-3']);
    expect(out).toContain('.p-3');
    expect(out).not.toContain('.modal');
    expect(out).not.toContain('.carousel');
  });

  it('keeps class-less selectors (reboot, :root and theme variables)', async () => {
    const out = await run(':root{--bs-x:1}[data-bs-theme=dark]{--y:2}body{m:0}', []);
    expect(out).toContain(':root');
    expect(out).toContain('[data-bs-theme=dark]');
    expect(out).toContain('body');
  });

  it('keeps runtime react-bootstrap classes via the safelist', async () => {
    const out = await run(
      '.btn{a:1}.btn-outline-secondary{a:1}.spinner-border{a:1}.tooltip.show{a:1}.btn-check:checked+.btn{a:1}',
      [],
    );
    for (const s of [
      '.btn{',
      '.btn-outline-secondary',
      '.spinner-border',
      '.tooltip.show',
      '.btn-check',
    ])
      expect(out).toContain(s);
  });

  it('trims a selector list to the used selectors and removes emptied @media blocks', async () => {
    const out = await run('@media (min-width:1px){.navbar{a:1}}.p-3,.navbar-x{b:1}', ['p-3']);
    expect(out).not.toContain('@media');
    expect(out).toContain('.p-3');
    expect(out).not.toContain('navbar');
  });

  it('keeps @keyframes and never touches CSS that is not from Bootstrap', async () => {
    const kf = await run('@keyframes spinner-border{to{transform:rotate(1turn)}}', []);
    expect(kf).toContain('@keyframes spinner-border');
    const app = await run('.modal{a:1}', [], '/x/src/styles/app.css');
    expect(app).toContain('.modal');
  });

  it('parses classes, ignoring attribute values and escapes', () => {
    expect(selectorClasses('.a.b:not(.c) [class*=".d"]')).toEqual(['a', 'b', 'c']);
    expect(selectorClasses('.sm\\:p-3')).toEqual(['sm:p-3']);
    expect(isUsed('btn-lg', new Set())).toBe(true);
    expect(isUsed('modal', new Set())).toBe(false);
  });

  it('finds class tokens in the real app source', () => {
    const tokens = sourceTokens();
    expect(tokens.has('flex')).toBe(true);
    expect(tokens.has('truncate')).toBe(true);
  });
});
