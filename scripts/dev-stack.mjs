#!/usr/bin/env node
/* global console, process, setTimeout, fetch */
/**
 * Reliable local stack for Windows/monorepo:
 *   1) ensure Docker infra (postgres / redis / minio)
 *   2) start API first
 *   3) wait until GET /health succeeds
 *   4) start worker + web
 *
 * Fixes: Vite ready while API still cold-starting, and API up with Redis/DB down.
 *
 * Usage: pnpm dev:stack
 */
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';
const children = [];
let shuttingDown = false;

function log(msg) {
  console.log(`[dev:stack] ${msg}`);
}

function runCapture(args) {
  const result = spawnSync(pnpm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed (${result.status ?? 'unknown'})`);
  }
}

function run(args, { label } = {}) {
  log(`spawn ${label ?? args.join(' ')}`);
  const child = spawn(pnpm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
    },
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      log(`${label ?? args.join(' ')} exited (${code}${signal ? `/${signal}` : ''})`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down…');
  for (const child of children) {
    try {
      if (!child.killed) child.kill(isWin ? undefined : 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), isWin ? 2000 : 500).unref?.();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url, timeoutMs = 180_000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(
          `API healthy at ${url} (${Math.round((Date.now() - start) / 1000)}s, attempt ${attempt})`,
        );
        return;
      }
    } catch {
      /* not up yet */
    }
    if (attempt === 1 || attempt % 5 === 0) {
      log(`waiting for API ${url}… (${Math.round((Date.now() - start) / 1000)}s)`);
    }
    await sleep(1000);
  }
  throw new Error(
    `API did not become healthy within ${Math.round(timeoutMs / 1000)}s at ${url}. ` +
      'Check the [api] logs above for errors.',
  );
}

const apiPort = process.env.PORT || '3000';
const healthUrl = `http://127.0.0.1:${apiPort}/health`;

try {
  log('ensuring Docker infra (postgres / redis / minio)…');
  runCapture(['dev:infra:up']);

  log('starting API first (wait for /health before web)…');
  run(['--filter', '@meetops/api', 'dev'], { label: 'api' });

  await waitForHealth(healthUrl);

  log('starting worker…');
  run(['--filter', '@meetops/worker', 'dev'], { label: 'worker' });

  log('starting web…');
  run(['--filter', '@meetops/web', 'dev'], { label: 'web' });

  log('stack up — API + worker + web. Ctrl+C to stop.');
} catch (err) {
  console.error('[dev:stack]', err instanceof Error ? err.message : err);
  shutdown(1);
}
