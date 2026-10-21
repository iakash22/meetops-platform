import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.WEB_PORT ?? 5173);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
// When E2E_BASE_URL points at an already-running env, don't start a dev server.
const startServer = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(startServer && {
    webServer: {
      command: `pnpm --filter @meetops/web dev --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  })
});
