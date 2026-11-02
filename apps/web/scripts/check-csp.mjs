#!/usr/bin/env node
/* global process, console */
/**
 * P9 R20: the web CSP has no 'unsafe-inline', so every inline <script>/<style> in the served index.html must have
 * its sha256 hash in the nginx CSP, and no element may carry a style= or on*= attribute.
 * Usage: node scripts/check-csp.mjs [index.html (default dist/index.html)] [nginx template]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(process.argv[2] ?? resolve(here, '..', 'dist', 'index.html'));
const templatePath = resolve(
  process.argv[3] ??
    resolve(here, '..', '..', '..', 'infra', 'docker', 'nginx', 'web.conf.template'),
);

export const inlineHash = (body) =>
  `'sha256-${createHash('sha256').update(body).digest('base64')}'`;

export function checkCsp(html, template) {
  const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(template)?.[1];
  if (!csp) return ['no Content-Security-Policy add_header in the nginx template'];
  const directive = (name) =>
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .find(([n]) => n === name)
      ?.slice(1) ?? [];
  const errors = [];
  for (const [tag, dir] of [
    ['style', 'style-src'],
    ['script', 'script-src'],
  ]) {
    const allowed = new Set(directive(dir));
    if (allowed.has("'unsafe-inline'")) errors.push(`${dir} must not allow 'unsafe-inline'`);
    const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    for (const m of html.matchAll(re)) {
      if (/\bsrc\s*=/i.test(m[1] ?? '')) continue;
      const h = inlineHash(m[2]);
      if (!allowed.has(h)) errors.push(`inline <${tag}> needs ${h} in ${dir}`);
    }
  }
  if (/<[^>]+\sstyle\s*=/i.test(html)) errors.push('style= attribute found (blocked by style-src)');
  if (/<[^>]+\son[a-z]+\s*=/i.test(html))
    errors.push('inline event handler found (blocked by script-src)');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkCsp(readFileSync(htmlPath, 'utf8'), readFileSync(templatePath, 'utf8'));
  for (const e of errors) console.error(`check-csp: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
