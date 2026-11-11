/* global process */
// PostCSS plugin: drop Bootstrap CSS rules whose classes the web app never uses. No dependencies.
//
// Only nodes that came from bootstrap/dist/css (inlined by Vite's @import handling) are touched; app CSS and
// Tailwind output pass through unchanged. A selector is kept when it has no class at all (reboot, :root and
// [data-bs-theme] variables) or when every class in it is "used": it appears as a token anywhere in the app source
// (src/** and index.html; permissive, so it over-keeps rather than under-keeps) or matches SAFELIST (classes
// react-bootstrap builds at runtime from props, e.g. `btn-${variant}`). SAFELIST is limited to the Button
// variants and sizes mapped in src/components/ui/button.tsx; unused families (every btn-* colour, Spinner,
// Dropdown, Overlay) used to inflate the CSS budget. Extend the list when those components are wired up.
// A rule with no selectors left is removed, and so is an at-rule (e.g. @media) with no children left.
// @keyframes, @font-face and the like are always kept.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

/** Runtime classes from react-bootstrap Button (see src/components/ui/button.tsx). */
export const SAFELIST = [
  // prefix + variant/size: primary, secondary, danger, outline-secondary, link, sm, lg.
  // btn-highlight is a static className in source, so sourceTokens keeps it.
  /^(btn|btn-(primary|secondary|danger|outline-secondary|link|sm|lg))$/,
  /^(active|disabled)$/,
];

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|html)$/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return SOURCE_EXT.test(e.name) ? [p] : [];
  });
}

/** Every identifier-like token in the app source (a superset of the class names it uses). */
export function sourceTokens(root = appRoot) {
  const tokens = new Set();
  for (const f of [...walk(join(root, 'src')), join(root, 'index.html')]) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const t of text.match(/[A-Za-z0-9_-]+/g) ?? []) tokens.add(t);
  }
  return tokens;
}

const CLASS_RE = /\.((?:\\.|[A-Za-z0-9_-])+)/g;
const unescape = (s) => s.replace(/\\(.)/g, '$1');

/** Class names in one selector (pseudo-classes and attribute values are not classes). */
export function selectorClasses(selector) {
  const stripped = selector.replace(/\[[^\]]*\]/g, '').replace(/:(not|is|where|has)\(/g, '(');
  return [...stripped.matchAll(CLASS_RE)].map((m) => unescape(m[1]));
}

export function isUsed(cls, tokens) {
  return tokens.has(cls) || SAFELIST.some((re) => re.test(cls));
}

const fromBootstrap = (node) => {
  const file = node.source?.input?.file;
  return typeof file === 'string' && file.split(sep).join('/').includes('/bootstrap/dist/css/');
};

/** @param {{ tokens?: Set<string>, match?: (node: any) => boolean }} [opts] */
export default function pruneBootstrap(opts = {}) {
  const match = opts.match ?? fromBootstrap;
  return {
    postcssPlugin: 'meetops-prune-bootstrap',
    OnceExit(root) {
      if (process.env.MEETOPS_KEEP_FULL_BOOTSTRAP === '1') return;
      const tokens = opts.tokens ?? sourceTokens();
      root.walkRules((rule) => {
        if (!match(rule)) return;
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        const kept = rule.selectors.filter((s) =>
          selectorClasses(s).every((c) => isUsed(c, tokens)),
        );
        if (!kept.length) rule.remove();
        else if (kept.length !== rule.selectors.length) rule.selectors = kept;
      });
      root.walkAtRules((at) => {
        if (match(at) && at.nodes && at.nodes.length === 0) at.remove();
      });
    },
  };
}
pruneBootstrap.postcss = true;
