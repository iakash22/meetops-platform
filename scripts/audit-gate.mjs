#!/usr/bin/env node
/* global process, console */
// CI audit gate. Fails on any high/critical advisory from `pnpm audit --json`
// except the explicitly documented, time-boxed exceptions below.
// Moderate/low advisories are reported but never block.
import { execFileSync } from 'node:child_process';

// RE-01: braces@3.0.3 (GHSA-vfj7-8cjw-p6xm) has no patched release; reached via
// tailwindcss@3 > chokidar/micromatch. Exception expires 2026-11-20 (end of day UTC).
const EXCEPTIONS = [
  {
    id: 'RE-01',
    ghsa: 'GHSA-vfj7-8cjw-p6xm',
    module: 'braces',
    versions: ['3.0.3'],
    expires: '2026-11-20T23:59:59Z',
  },
];
const BLOCKING = new Set(['high', 'critical']);

let raw;
try {
  raw = execFileSync('pnpm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (e) {
  raw = e.stdout; // pnpm audit exits non-zero when advisories exist
}
const advisories = Object.values(JSON.parse(raw).advisories ?? {});
const now = new Date(process.env.AUDIT_GATE_NOW ?? Date.now());
let failed = false;

for (const a of advisories) {
  const versions = [...new Set(a.findings.flatMap((f) => f.version))];
  const label = `${a.severity.toUpperCase()} ${a.github_advisory_id} ${a.module_name}@${versions.join(',')}`;
  if (!BLOCKING.has(a.severity)) {
    console.log(`non-blocking: ${label}`);
    continue;
  }
  const ex = EXCEPTIONS.find(
    (x) =>
      x.ghsa === a.github_advisory_id &&
      x.module === a.module_name &&
      versions.every((v) => x.versions.includes(v)),
  );
  if (ex && now <= new Date(ex.expires)) {
    console.log(`excepted (${ex.id}, expires ${ex.expires}): ${label}`);
    continue;
  }
  if (ex) console.error(`::error::exception ${ex.id} expired ${ex.expires}: ${label}`);
  else console.error(`::error::blocking advisory: ${label}`);
  failed = true;
}
console.log(`${advisories.length} advisories checked; gate ${failed ? 'FAILED' : 'passed'}`);
process.exit(failed ? 1 : 0);
