import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../scripts/ensure-contracts-dist.mjs', import.meta.url));
const scriptSource = readFileSync(scriptPath, 'utf8');

const fixtures: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ensure-contracts-dist-'));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function loadScript() {
  const mod = await import(pathToFileURL(scriptPath).href);
  return mod as {
    findRepoRoot: (startDir: string) => string;
    resolveTscBin: (root: string, contractsDir: string) => string;
    main: () => number;
  };
}

function writeFakeTsc(root: string, tscBody: string) {
  const tscDir = path.join(root, 'node_modules', 'typescript', 'bin');
  mkdirSync(tscDir, { recursive: true });
  writeFileSync(
    path.join(root, 'node_modules', 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: '5.0.0', bin: { tsc: 'bin/tsc' } }),
  );
  writeFileSync(path.join(tscDir, 'tsc'), tscBody, { mode: 0o755 });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  );
}

function writeContractsPackage(root: string) {
  const contractsDir = path.join(root, 'packages', 'contracts');
  mkdirSync(path.join(contractsDir, 'src'), { recursive: true });
  writeFileSync(
    path.join(contractsDir, 'package.json'),
    JSON.stringify({ name: '@meetops/contracts', private: true }),
  );
  writeFileSync(path.join(contractsDir, 'tsconfig.json'), JSON.stringify({ include: ['src'] }));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  return contractsDir;
}

const FAKE_TSC = `#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const stamp = process.env.TSC_STAMP;
if (stamp) appendFileSync(stamp, 'ran\\n');
mkdirSync(path.join(process.cwd(), 'dist'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'dist', 'index.js'), 'export {}\\n');
writeFileSync(path.join(process.cwd(), 'dist', 'types.js'), 'export {}\\n');
`;

function layoutScript(root: string) {
  const destDir = path.join(root, 'apps', 'extension', 'scripts');
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'ensure-contracts-dist.mjs');
  writeFileSync(dest, scriptSource);
  return dest;
}

describe('ensure-contracts-dist', () => {
  it('walks up to pnpm-workspace.yaml instead of using a fixed relative path', async () => {
    const { findRepoRoot } = await loadScript();
    const root = makeFixture();
    const nested = path.join(root, 'apps', 'extension', 'scripts');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('throws when no workspace file exists on the walk', async () => {
    const { findRepoRoot } = await loadScript();
    const root = makeFixture();
    const nested = path.join(root, 'apps', 'extension', 'scripts');
    mkdirSync(nested, { recursive: true });
    expect(() => findRepoRoot(nested)).toThrow(/pnpm-workspace\.yaml/);
  });

  it('finds this monorepo root from the real script directory', async () => {
    const { findRepoRoot } = await loadScript();
    const scriptDir = path.dirname(scriptPath);
    const root = findRepoRoot(scriptDir);
    expect(existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(path.join(root, 'packages', 'contracts', 'package.json'))).toBe(true);
  });

  it('does not invoke pnpm, so the Windows npm_execpath .cmd fallback is unused', () => {
    expect(scriptSource).not.toMatch(/process\.env\.npm_execpath/);
    expect(scriptSource).not.toMatch(/['"]pnpm\.cmd['"]/);
    expect(scriptSource).not.toMatch(/--filter['"],\s*['"]@meetops\/contracts/);
    expect(scriptSource).toMatch(/typescript\/bin\/tsc/);
    // The only remaining pnpm --filter mention is the stale-dist rebuild hint.
    const filterMentions = scriptSource.match(/pnpm --filter/g) ?? [];
    expect(filterMentions).toHaveLength(1);
    expect(scriptSource).toMatch(/stale dist[\s\S]*pnpm --filter @meetops\/contracts build/);
  });

  it('builds contracts with node on the tsc bin when dist is missing', () => {
    const root = makeFixture();
    const contractsDir = writeContractsPackage(root);
    const stamp = path.join(root, 'tsc-stamp');
    writeFakeTsc(root, FAKE_TSC);
    const script = layoutScript(root);

    const first = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TSC_STAMP: stamp },
    });
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(path.join(contractsDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(path.join(contractsDir, 'dist', 'types.js'))).toBe(true);
    expect(readFileSync(stamp, 'utf8').trim().split('\n')).toEqual(['ran']);

    const second = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TSC_STAMP: stamp },
    });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(stamp, 'utf8').trim().split('\n')).toEqual(['ran']);
  });

  it('resolves tsc from the contracts package or the workspace root', async () => {
    const { resolveTscBin } = await loadScript();
    const root = makeFixture();
    const contractsDir = writeContractsPackage(root);
    writeFakeTsc(root, FAKE_TSC);
    const resolved = resolveTscBin(root, contractsDir);
    expect(resolved).toBe(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'));
  });
});
