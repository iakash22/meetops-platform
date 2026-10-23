import { expect, test } from '@playwright/test';

test('web app loads and renders the root', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#root')).not.toBeEmpty();
});
