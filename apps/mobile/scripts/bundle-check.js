/* global __dirname, process, require */
// Export smoke check: bundles the app for Android and iOS into a temp dir,
// then removes it. Fails (non-zero exit) if Metro cannot resolve the graph.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
/** Local Expo CLI via node (Windows: `spawnSync('npx')` is ENOENT when npx.cmd is not on PATH for execFileSync). */
const expoCli = path.join(
  path.dirname(require.resolve('expo/package.json', { paths: [appRoot] })),
  'bin',
  'cli',
);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetops-mobile-export-'));
try {
  execFileSync(
    process.execPath,
    [expoCli, 'export', '--platform', 'android', '--platform', 'ios', '--output-dir', outDir],
    { cwd: appRoot, stdio: 'inherit', env: { ...process.env, CI: '1' } },
  );
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
