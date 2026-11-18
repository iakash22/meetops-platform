#!/usr/bin/env node
/* global process, console */
/**
 * `wxt prepare` (this package's postinstall) resolves `@meetops/contracts` from
 * dist/. On a fresh `pnpm install`, that build has not run yet, so create it
 * when missing. Skip when dist/ already exists so routine installs stay fast.
 * Windows-safe: no shell syntax; prefers `node $npm_execpath` when pnpm/npm
 * launched this script.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function contractsRoot() {
  try {
    return path.dirname(require.resolve('@meetops/contracts/package.json'));
  } catch {
    return path.join(repoRoot(), 'packages', 'contracts');
  }
}

function runPnpm(args, cwd) {
  const execPath = process.env.npm_execpath;
  if (execPath) {
    return spawnSync(process.execPath, [execPath, ...args], {
      stdio: 'inherit',
      cwd,
      env: process.env,
    });
  }
  const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(bin, args, {
    stdio: 'inherit',
    cwd,
    env: process.env,
    shell: process.platform === 'win32',
  });
}

const contractsDir = contractsRoot();
const distIndex = path.join(contractsDir, 'dist', 'index.js');
const distTypes = path.join(contractsDir, 'dist', 'types.js');
if (existsSync(distIndex) && existsSync(distTypes)) {
  process.exit(0);
}

console.log(
  '@meetops/extension: @meetops/contracts dist/ is missing; building it before wxt prepare',
);
const result = runPnpm(['--filter', '@meetops/contracts', 'build'], repoRoot());
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
if (!existsSync(distIndex) || !existsSync(distTypes)) {
  console.error(
    '@meetops/contracts build finished but dist/index.js or dist/types.js is still missing',
  );
  process.exit(1);
}
