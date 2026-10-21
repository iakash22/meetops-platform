import { defineConfig, devices } from '@playwright/test';

// Dev server port (vite). Default matches apps/web/vite.config.ts.
const port = Number(process.env.WEB_PORT ?? 5173);
// Port of the web container (nginx, 8080 in infra/compose/compose.app.yml). When set,
// tests run against the container instead of starting the dev server.
const containerPort = process.env.E2E_CONTAINER_PORT;
const baseURL =
  process.env.E2E_BASE_URL ??
  (containerPort ? `http://localhost:${containerPort}` : `http://localhost:${port}`);
// Only start the vite dev server when no external target was given.
const startServer = !process.env.E2E_BASE_URL && !containerPort;

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
