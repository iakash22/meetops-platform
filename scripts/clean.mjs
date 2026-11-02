#!/usr/bin/env node
/* global console, process */
/**
 * Cross-platform cleanup for MeetOps monorepo caches and build artifacts.
 *
 * Usage:
 *   node scripts/clean.mjs turbo
 *   node scripts/clean.mjs build
 *   node scripts/clean.mjs cache
 *   node scripts/clean.mjs modules # root + apps + packages + tests node_modules
 *   node scripts/clean.mjs data    # docker compose volumes (destructive)
 *   node scripts/clean.mjs all     # turbo + build + cache (not modules/data)
 *   node scripts/clean.mjs full    # all + modules across apps/packages/tests
 *   node scripts/clean.mjs deep    # full + data
 */
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store']);

/** Directory / file name matchers relative to a walked folder. */
const WORKSPACE_ROOTS = ['apps', 'packages', 'tests'];

const BUILD_NAMES = new Set([
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'test-results',
  'playwright-report',
  'storybook-static',
  '.expo',
  '.expo-shared',
]);
const BUILD_FILE_SUFFIXES = ['.tsbuildinfo'];

const CACHE_NAMES = new Set([
  '.vite',
  '.eslintcache',
  '.cache',
  '.parcel-cache',
  '.nyc_output',
  'node_modules/.cache',
]);
const CACHE_FILE_NAMES = new Set(['.eslintcache']);

/** Extra generated dirs cleaned only on full/all-workspace sweeps. */
const FULL_EXTRA_NAMES = new Set(['.turbo', '.expo', '.expo-shared', 'coverage', 'tmp', 'temp']);

function removePath(abs, label) {
  if (!existsSync(abs)) return false;
  rmSync(abs, { recursive: true, force: true });
  console.log(`  removed ${label ?? relative(root, abs)}`);
  return true;
}

function walk(dir, onDir, onFile, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (onDir?.(abs, ent.name)) continue; // skip children if handler says done
      walk(abs, onDir, onFile, depth + 1);
    } else if (ent.isFile()) {
      onFile?.(abs, ent.name);
    }
  }
}

function cleanTurbo() {
  console.log('clean:turbo');
  let n = 0;
  if (removePath(join(root, '.turbo'), '.turbo')) n += 1;
  // Nested turbo caches from filtered runs
  walk(root, (abs, name) => {
    if (name === '.turbo') {
      removePath(abs);
      n += 1;
      return true;
    }
    return false;
  });
  if (n === 0) console.log('  (nothing to remove)');
}

function cleanBuild() {
  console.log('clean:build');
  let n = 0;
  walk(
    root,
    (abs, name) => {
      if (BUILD_NAMES.has(name)) {
        // Keep source folders named build/ only if they look like source (rare); turbo outputs win.
        try {
          if (statSync(abs).isDirectory()) {
            removePath(abs);
            n += 1;
            return true;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    },
    (abs, name) => {
      if (BUILD_FILE_SUFFIXES.some((s) => name.endsWith(s))) {
        removePath(abs);
        n += 1;
      }
    },
  );
  if (n === 0) console.log('  (nothing to remove)');
}

function cleanCache() {
  console.log('clean:cache');
  let n = 0;
  // Root-level tool caches
  for (const name of ['.eslintcache', 'node_modules/.cache']) {
    if (removePath(join(root, name), name)) n += 1;
  }
  walk(
    root,
    (abs, name) => {
      if (CACHE_NAMES.has(name) || name === '.vite') {
        removePath(abs);
        n += 1;
        return true;
      }
      // apps/**/node_modules/.cache
      if (name === 'node_modules') {
        const cache = join(abs, '.cache');
        if (removePath(cache, relative(root, cache))) n += 1;
        return true; // do not walk into node_modules
      }
      return false;
    },
    (abs, name) => {
      if (CACHE_FILE_NAMES.has(name)) {
        removePath(abs);
        n += 1;
      }
    },
  );
  if (n === 0) console.log('  (nothing to remove)');
}

function cleanModules() {
  console.log('clean:modules (root + apps + packages + tests)');
  let n = 0;
  if (removePath(join(root, 'node_modules'), 'node_modules')) n += 1;
  for (const workspace of WORKSPACE_ROOTS) {
    const base = join(root, workspace);
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const nm = join(base, ent.name, 'node_modules');
      if (removePath(nm, relative(root, nm))) n += 1;
    }
  }
  // Nested package folders (e.g. packages/*/packages) — one more level
  walk(
    root,
    (abs, name) => {
      if (name === 'node_modules') {
        removePath(abs);
        n += 1;
        return true;
      }
      if (SKIP_DIRS.has(name) || name === '.git') return true;
      return false;
    },
    undefined,
    0,
  );
  if (n === 0) console.log('  (nothing to remove)');
}

function cleanWorkspaceExtras() {
  console.log('clean:workspace (apps / packages / tests extras)');
  let n = 0;
  for (const workspace of WORKSPACE_ROOTS) {
    const base = join(root, workspace);
    if (!existsSync(base)) continue;
    walk(
      base,
      (abs, name) => {
        if (FULL_EXTRA_NAMES.has(name) || BUILD_NAMES.has(name)) {
          // Do not wipe native app source trees named android/ios under mobile
          // unless they look generated (Expo prebuild). Prefer .expo / dist / .turbo.
          if (name === 'android' || name === 'ios') {
            return false;
          }
          removePath(abs);
          n += 1;
          return true;
        }
        if (name === 'node_modules') return true;
        return false;
      },
      (abs, name) => {
        if (BUILD_FILE_SUFFIXES.some((s) => name.endsWith(s))) {
          removePath(abs);
          n += 1;
        }
      },
    );
  }
  if (n === 0) console.log('  (nothing to remove)');
}

function cleanData() {
  console.log('clean:data (docker compose volumes for meetops-dev)');
  const compose = join(root, 'infra/compose/compose.dev.yml');
  if (!existsSync(compose)) {
    console.error('  compose.dev.yml not found; skip');
    process.exitCode = 1;
    return;
  }
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const result = spawnSync(
    docker,
    [
      'compose',
      '--env-file',
      '.env',
      '-f',
      'infra/compose/compose.dev.yml',
      'down',
      '-v',
      '--remove-orphans',
    ],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) {
    console.error('  docker compose down -v failed (is Docker running?)');
    process.exitCode = result.status ?? 1;
  }
}

function cleanAllArtifacts() {
  cleanTurbo();
  cleanBuild();
  cleanCache();
}

function cleanFull() {
  cleanAllArtifacts();
  cleanWorkspaceExtras();
  cleanModules();
}

const target = (process.argv[2] || 'all').toLowerCase();

switch (target) {
  case 'turbo':
    cleanTurbo();
    break;
  case 'build':
    cleanBuild();
    break;
  case 'cache':
    cleanCache();
    break;
  case 'modules':
    cleanModules();
    break;
  case 'data':
    cleanData();
    break;
  case 'all':
    cleanAllArtifacts();
    break;
  case 'full':
    cleanFull();
    break;
  case 'deep':
    cleanFull();
    cleanData();
    break;
  default:
    console.error(
      `Unknown target "${target}". Use: turbo | build | cache | modules | data | all | full | deep`,
    );
    process.exit(1);
}
