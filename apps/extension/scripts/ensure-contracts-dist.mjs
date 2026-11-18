#!/usr/bin/env node
/* global process, console */
/**
 * `wxt prepare` (this package's postinstall) resolves `@meetops/contracts` from
 * dist/. On a fresh `pnpm install`, that build has not run yet, so create it
 * when missing. Skip when dist/ already exists so routine installs stay fast.
 * Windows-safe: no shell syntax; builds contracts by running `node` on the
 * TypeScript bin with `-p tsconfig.json`, matching the contracts "build"
 * script, so a nested pnpm filter build cannot contend for the store lock.
 * The previous Windows npm execpath .cmd/.bat fallback is gone because this
 * path no longer invokes pnpm.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

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
  const distIndex = path.join(contractsDir, 'dist', 'index.js');
  const distTypes = path.join(contractsDir, 'dist', 'types.js');
  // Skip when dist already exists so routine installs stay fast. This is
  // intentional: a stale dist is not rebuilt here. Refresh it with
  // `pnpm --filter @meetops/contracts build`.
  if (existsSync(distIndex) && existsSync(distTypes)) {
    return 0;
  }

  console.log(
    '@meetops/extension: @meetops/contracts dist/ is missing; building it before wxt prepare',
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
  if (!existsSync(distIndex) || !existsSync(distTypes)) {
    console.error(
      '@meetops/contracts build finished but dist/index.js or dist/types.js is still missing',
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
