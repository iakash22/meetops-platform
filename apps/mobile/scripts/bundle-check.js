/* global __dirname, process, require */
// Export smoke check: bundles the app for Android and iOS into a temp dir,
// then removes it. Fails (non-zero exit) if Metro cannot resolve the graph.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetops-mobile-export-'));
try {
  execFileSync(
    'npx',
    ['expo', 'export', '--platform', 'android', '--platform', 'ios', '--output-dir', outDir],
    { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env: { ...process.env, CI: '1' } },
  );
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
