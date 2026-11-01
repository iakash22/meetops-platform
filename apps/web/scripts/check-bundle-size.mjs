#!/usr/bin/env node
/* global process, console */
// Bundle-size budget for apps/web. No dependencies: node:fs + node:zlib only.
//
//   pnpm --filter @meetops/web build && node apps/web/scripts/check-bundle-size.mjs
//   node scripts/check-bundle-size.mjs --json        (from apps/web; machine-readable)
//   node scripts/check-bundle-size.mjs --dist <dir>  (another build output)
//
// Budgets are gzip bytes per chunk *name* (the part before the content hash), plus totals for the
// initial JS (what index.html loads: its entry script and modulepreloads) and for all JS. Exits 1 if any budget is exceeded or a JS chunk passes Vite's 500 kB warning.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
/**
 * gzip budgets in kB. Roughly 15-20% headroom over the measured build. Vendor budgets are from the
 * perf/web-bundle build; index, css, initialJs and totalJs were re-baselined when the check was wired
 * into the gates (integration/phase-1 @e4aceac4: index 38.34, css 9.02, initial JS 156.42, all JS 249.31).
 * Raise a budget only in the PR that needs it, with the reason.
 */
const BUDGETS = {
  react: 55,
  tanstack: 45,
  radix: 38,
  icons: 6,
  validation: 45, // zod + react-hook-form
  index: 45, // app code in the entry chunk
  '*': 25, // any other JS chunk (lazy route chunks)
  css: 11,
  initialJs: 185, // entry + modulepreloads in index.html
  totalJs: 290, // every JS chunk, lazy ones included
};
const RAW_CHUNK_LIMIT = 500 * KB; // Vite's chunkSizeWarningLimit default

const args = process.argv.slice(2);
const json = args.includes('--json');
const distArg = args.indexOf('--dist');
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(distArg !== -1 ? args[distArg + 1] : join(here, '..', 'dist'));
const assets = join(dist, 'assets');

let files;
try {
  files = readdirSync(assets);
} catch {
  console.error(`No build output at ${assets}. Run the web build first.`);
  process.exit(2);
}

const rows = files
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((file) => {
    const buf = readFileSync(join(assets, file));
    const type = file.endsWith('.css') ? 'css' : 'js';
    const name = file.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '');
    const budgetKb = type === 'css' ? BUDGETS.css : (BUDGETS[name] ?? BUDGETS['*']);
    return {
      file,
      name,
      type,
      raw: statSync(join(assets, file)).size,
      gzip: gzipSync(buf, { level: 9 }).length,
      budgetKb,
    };
  })
  .sort((a, b) => b.gzip - a.gzip);

const failures = [];
for (const r of rows) {
  if (r.gzip > r.budgetKb * KB)
    failures.push(`${r.file}: ${(r.gzip / KB).toFixed(2)} kB gzip > ${r.budgetKb} kB budget`);
  if (r.type === 'js' && r.raw > RAW_CHUNK_LIMIT)
    failures.push(`${r.file}: ${(r.raw / KB).toFixed(2)} kB raw > 500 kB`);
}
const sum = (type, key) => rows.filter((r) => r.type === type).reduce((n, r) => n + r[key], 0);
// Initial JS = the chunks index.html itself loads (entry <script> + <link rel="modulepreload">).
let initialFiles = [];
try {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  initialFiles = [
    ...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="[^"]*\/assets\/([^"/]+\.js)"/g),
  ].map((m) => m[1]);
  // Without an entry script the initial-JS total would be 0 kB and the budget would pass silently.
  const hasEntry = /<script\b[^>]*?\bsrc="[^"]*\/assets\/[^"/]+\.js"/.test(html);
  if (!hasEntry)
    failures.push(
      'index.html has no entry <script src=".../assets/*.js">; cannot measure initial JS',
    );
} catch {
  failures.push('index.html missing from the build output');
}
for (const r of rows) r.initial = initialFiles.includes(r.file);
const initialJsGzip = rows.filter((r) => r.initial).reduce((n, r) => n + r.gzip, 0);
const totals = {
  initialJsGzip,
  jsRaw: sum('js', 'raw'),
  jsGzip: sum('js', 'gzip'),
  cssRaw: sum('css', 'raw'),
  cssGzip: sum('css', 'gzip'),
};
if (initialJsGzip > BUDGETS.initialJs * KB)
  failures.push(
    `initial JS ${(initialJsGzip / KB).toFixed(2)} kB gzip > ${BUDGETS.initialJs} kB budget`,
  );
if (totals.jsGzip > BUDGETS.totalJs * KB)
  failures.push(
    `total JS ${(totals.jsGzip / KB).toFixed(2)} kB gzip > ${BUDGETS.totalJs} kB budget`,
  );

if (json) {
  console.log(JSON.stringify({ dist, rows, totals, failures }, null, 2));
} else {
  const fmt = (n) => (n / KB).toFixed(2).padStart(9);
  console.log(
    `${'chunk'.padEnd(34)}${'raw kB'.padStart(9)}${'gzip kB'.padStart(9)}${'budget'.padStart(8)}`,
  );
  for (const r of rows)
    console.log(
      `${(r.file + (r.initial ? ' *' : '')).padEnd(34)}${fmt(r.raw)}${fmt(r.gzip)}${String(r.budgetKb).padStart(8)}`,
    );
  console.log(
    `${'initial JS (*)'.padEnd(34)}${' '.repeat(9)}${fmt(initialJsGzip)}${String(BUDGETS.initialJs).padStart(8)}`,
  );
  console.log(
    `${'total JS'.padEnd(34)}${fmt(totals.jsRaw)}${fmt(totals.jsGzip)}${String(BUDGETS.totalJs).padStart(8)}`,
  );
  console.log(`${'total CSS'.padEnd(34)}${fmt(totals.cssRaw)}${fmt(totals.cssGzip)}`);
  if (failures.length) console.error(`\nBundle budget exceeded:\n  ${failures.join('\n  ')}`);
  else console.log('\nBundle budget OK');
}
process.exit(failures.length ? 1 : 0);
