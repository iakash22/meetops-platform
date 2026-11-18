#!/usr/bin/env node
/* global process, console */
/**
 * `wxt prepare` (this package's postinstall) resolves `@meetops/contracts` from
 * dist/. On a fresh `pnpm install`, that build has not run yet, so create it
 * when missing. Skip when dist/ is already a usable build so routine installs
 * stay fast. An empty or truncated file does not count as present: rebuild it.
 * Windows-safe: no shell syntax; builds contracts by running `node` on the
 * TypeScript bin with `-p tsconfig.json`, matching the contracts "build"
 * script, so a nested pnpm filter build cannot contend for the store lock.
 * The previous Windows npm execpath .cmd/.bat fallback is gone because this
 * path no longer invokes pnpm.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Markers a real `tsc -p` emit of @meetops/contracts writes into these entries.
 * An empty or truncated file will not contain them.
 */
export const DIST_SENTINELS = {
  'index.js': "export * from './formats.js'",
  'types.js': "export * from './constants.js'",
};

/**
 * Walk up from `startDir` until `pnpm-workspace.yaml` is found.
 * @param {string} startDir
 * @returns {string}
 */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find repository root (pnpm-workspace.yaml) from ${startDir}`);
    }
    dir = parent;
  }
}

function repoRoot() {
  return findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
}

function contractsRoot() {
  try {
    return path.dirname(require.resolve('@meetops/contracts/package.json'));
  } catch {
    return path.join(repoRoot(), 'packages', 'contracts');
  }
}

/**
 * True when `file` exists, is a regular file, and has a non-zero size.
 * @param {string} file
 * @returns {boolean}
 */
export function isUsableDistFile(file) {
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * True when contracts dist/ has both JS entries, matching .d.ts files, and
 * the expected export sentinels. Empty, truncated, or missing files fail.
 * @param {string} contractsDir
 * @returns {boolean}
 */
export function isContractsDistReady(contractsDir) {
  const distDir = path.join(contractsDir, 'dist');
  for (const [name, sentinel] of Object.entries(DIST_SENTINELS)) {
    const js = path.join(distDir, name);
    const dts = path.join(distDir, name.replace(/\.js$/, '.d.ts'));
    if (!isUsableDistFile(js) || !isUsableDistFile(dts)) {
      return false;
    }
    try {
      if (!readFileSync(js, 'utf8').includes(sentinel)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the `tsc` JS entry the same way a `tsc -p tsconfig.json` run from
 * the contracts package would, without going through the `pnpm` CLI.
 * @param {string} root
 * @param {string} contractsDir
 * @returns {string}
 */
export function resolveTscBin(root, contractsDir) {
  const starts = [contractsDir, root, path.join(root, 'apps', 'extension')];
  for (const start of starts) {
    try {
      return createRequire(path.join(start, 'package.json')).resolve('typescript/bin/tsc');
    } catch {
      // pnpm may hoist typescript under only one of these package roots.
    }
  }
  throw new Error('Unable to resolve typescript/bin/tsc to build @meetops/contracts');
}

export function main() {
  const contractsDir = contractsRoot();
  // Skip when dist is already a usable build so routine installs stay fast.
  // This is intentional: a stale-but-valid dist is not rebuilt here. Refresh
  // it with `pnpm --filter @meetops/contracts build`. Empty, truncated, or
  // sentinel-missing files do not skip; they trigger a rebuild.
  if (isContractsDistReady(contractsDir)) {
    return 0;
  }

  console.log(
    '@meetops/extension: @meetops/contracts dist/ is missing or incomplete; building it before wxt prepare',
  );

  const tscBin = resolveTscBin(repoRoot(), contractsDir);
  const result = spawnSync(
    process.execPath,
    [tscBin, '-p', path.join(contractsDir, 'tsconfig.json')],
    {
      cwd: contractsDir,
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  if (result.status !== 0) {
    return result.status ?? 1;
  }
  if (!isContractsDistReady(contractsDir)) {
    console.error(
      '@meetops/contracts build finished but dist/index.js or dist/types.js is still missing, empty, or missing expected exports',
    );
    return 1;
  }
  return 0;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.normalize(fileURLToPath(import.meta.url)) === path.normalize(path.resolve(entry));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const status = main();
  if (status !== 0) {
    process.exit(status);
  }
}
