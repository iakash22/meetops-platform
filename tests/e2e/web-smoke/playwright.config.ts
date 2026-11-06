import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Web E2E smoke: sign-up → org → meeting → upload → transcript + summary, against this checkout's
// built apps/api (in-memory deps, NODE_ENV=test) and apps/web dist. See README.md for prerequisites.
// Default to this checkout's apps (the flow stack reads these; workers inherit the env).
process.env.QA_API_DIR ??= fileURLToPath(new URL('../../../apps/api', import.meta.url));
process.env.QA_WEB_DIR ??= fileURLToPath(new URL('../../../apps/web', import.meta.url));
const executablePath = process.env.E2E_CHROME_EXECUTABLE || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: '../../test-results/web-smoke',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure', ...(executablePath && { launchOptions: { executablePath } }) },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
