#!/usr/bin/env node
/* global process, console */
// CI audit gate: blocking on high/critical advisories from `pnpm audit --json`,
// except the explicitly documented, time-boxed, owned exceptions below.
// Moderate/low advisories are printed but never block.
//
// Fails closed: an `error` field, missing `advisories`/`metadata`, unparseable
// output, or a non-zero pnpm exit with zero advisories all fail the gate.
//
// AUDIT_GATE_NOW (ISO date) overrides "now" for local tests only; it is
// ignored when CI=true or GITHUB_ACTIONS=true.
//
// Related root package.json overrides (JSON has no comments, so documented here):
//   "tailwindcss>postcss-nested": "^7.0.2"
//   "tailwindcss>postcss-selector-parser": "^7.1.6"
// tailwindcss@3 pins postcss-nested 6 / postcss-selector-parser 6, which carry
// audit findings (incl. the moderate postcss-selector-parser advisory). Both
// overrides only exist for tailwind 3 and must be removed with the tailwind 4
// migration (same exit plan as RE-01, see issue #54).
//   "tmp@<0.2.6": "^0.2.6"            GHSA-ph9p-34f9-6g65 (web-ext-run pins tmp 0.2.5;
//                                      also fengari/testcontainers). Remove once web-ext-run ships >=0.2.6.
//   "firefox-profile@4.7.0": "4.7.1"  pulls adm-zip ~0.6.x (0.6.1) for GHSA-xcpc-8h2w-3j85,
//                                      -7q85-xj36-vmfc, -rcw4-f5rp-g42v, -j5f4-cc29-5x44, -8238-w5pm-2374
//                                      (web-ext-run pins firefox-profile 4.7.0). Remove once web-ext-run bumps it.
import { spawnSync } from 'node:child_process';

const EXCEPTIONS = [
  {
    // braces@3.0.3 has no patched release; reached only via tailwindcss@3 >
    // chokidar/micromatch/fast-glob in apps/web (build-time). Exit plan:
    // tailwind 4 migration or a patched braces via pnpm.overrides.
    id: 'RE-01',
    owner: 'DevOps Agent',
    issue: 'https://github.com/iakash22/meetops-platform/issues/54',
    ghsa: 'GHSA-vfj7-8cjw-p6xm',
    module: 'braces',
    versions: ['3.0.3'],
    expires: '2026-11-20T23:59:59Z',
  },
];
const BLOCKING = new Set(['high', 'critical']);

function fail(msg) {
  console.error(`::error::audit gate: ${msg}`);
  process.exit(1);
}

const inCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
let now = new Date();
if (process.env.AUDIT_GATE_NOW) {
  if (inCI) {
    console.log('AUDIT_GATE_NOW ignored in CI');
  } else {
    now = new Date(process.env.AUDIT_GATE_NOW);
    if (Number.isNaN(now.getTime())) fail(`invalid AUDIT_GATE_NOW: ${process.env.AUDIT_GATE_NOW}`);
    console.log(`using AUDIT_GATE_NOW=${now.toISOString()} (local test)`);
  }
}

const res = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (res.error) fail(`could not run pnpm audit: ${res.error.message}`);

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  fail(
    `pnpm audit output is not JSON (exit ${res.status}): ${String(res.stderr || res.stdout).slice(0, 500)}`,
  );
}
if (!report || typeof report !== 'object') fail('pnpm audit returned no report');
if (report.error) fail(`pnpm audit reported an error: ${JSON.stringify(report.error)}`);
if (!report.advisories || typeof report.advisories !== 'object')
  fail('report has no advisories object');
if (!report.metadata || typeof report.metadata !== 'object') fail('report has no metadata object');

const advisories = Object.values(report.advisories);
if (res.status !== 0 && advisories.length === 0)
  fail(`pnpm audit exited ${res.status} with zero advisories`);

let failed = false;
for (const a of advisories) {
  const versions = [...new Set((a.findings ?? []).map((f) => f.version))];
  const label = `${String(a.severity).toUpperCase()} ${a.github_advisory_id} ${a.module_name}@${versions.join(',')}`;
  if (!BLOCKING.has(a.severity) && ['moderate', 'low', 'info'].includes(a.severity)) {
    console.log(`non-blocking: ${label}`);
    continue;
  }
  const ex = EXCEPTIONS.find(
    (x) =>
      x.ghsa === a.github_advisory_id &&
      x.module === a.module_name &&
      Array.isArray(a.findings) &&
      a.findings.length > 0 &&
      a.findings.every((f) => f && typeof f.version === 'string' && x.versions.includes(f.version)),
  );
  if (ex && now <= new Date(ex.expires)) {
    console.log(
      `excepted (${ex.id}, owner ${ex.owner}, expires ${ex.expires}, ${ex.issue}): ${label}`,
    );
    continue;
  }
  if (ex)
    console.error(`::error::exception ${ex.id} expired ${ex.expires} (${ex.issue}): ${label}`);
  else console.error(`::error::blocking advisory: ${label}`);
  failed = true;
}
console.log(`${advisories.length} advisories checked; gate ${failed ? 'FAILED' : 'passed'}`);
process.exit(failed ? 1 : 0);
