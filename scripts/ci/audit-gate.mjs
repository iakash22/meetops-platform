#!/usr/bin/env node
// Blocking pnpm audit gate with time-boxed, per-GHSA exceptions.
// Usage: pnpm audit --json | node scripts/ci/audit-gate.mjs [allowlist.json]
// Fails (exit 1) when: any high/critical advisory is not allowlisted, or any
// allowlist entry is past its expiry date. Unused entries are reported.
import { readFileSync } from 'node:fs';

const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const threshold = LEVELS[process.env.AUDIT_LEVEL ?? 'high'];
const allowPath = process.argv[2] ?? '.github/audit-allowlist.json';
const today = (process.env.AUDIT_TODAY ?? new Date().toISOString()).slice(0, 10);

const report = JSON.parse(readFileSync(0, 'utf8'));
const { allow } = JSON.parse(readFileSync(allowPath, 'utf8'));
let failed = false;

const byGhsa = new Map(allow.map((e) => [e.ghsa, e]));
for (const e of allow) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '')) {
    console.error(`::error::allowlist ${e.ghsa}: missing/invalid expires`);
    failed = true;
  } else if (e.expires < today) {
    console.error(
      `::error::allowlist ${e.ghsa} (${e.package}) EXPIRED on ${e.expires}: fix it or renew deliberately`,
    );
    failed = true;
  }
}

const used = new Set();
for (const a of Object.values(report.advisories ?? {})) {
  if ((LEVELS[a.severity] ?? 0) < threshold) continue;
  const id = a.github_advisory_id;
  const path = a.findings?.[0]?.paths?.[0] ?? '';
  if (byGhsa.has(id)) {
    used.add(id);
    console.log(
      `allowed  ${a.severity.padEnd(8)} ${id} ${a.module_name} (until ${byGhsa.get(id).expires}) ${path}`,
    );
  } else {
    console.error(`::error::${a.severity} ${id} ${a.module_name}: ${a.title} (${path})`);
    failed = true;
  }
}
for (const e of allow)
  if (!used.has(e.ghsa))
    console.log(`note: allowlist ${e.ghsa} (${e.package}) no longer needed; remove it`);

console.log(failed ? 'audit gate: FAIL' : 'audit gate: PASS');
process.exit(failed ? 1 : 0);
