import { defineConfig, devices } from '@playwright/test';

// Web E2E flow against external checkouts (QA_WEB_DIR = PR #48 apps/web, QA_API_DIR = an
// apps/api with the auth/orgs modules). Each test starts its own in-memory API and proxy.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.flow.ts',
  outputDir: '../../test-results/flow',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
