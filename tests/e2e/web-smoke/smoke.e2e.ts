import { expect, test as base } from '@playwright/test';
import { fixturePassword } from '../../support/fixture-secrets.js';
import { flowSkipReason, Stack } from '../flow/stack.js';
import { FakePipeline, STUB } from './fake-pipeline.js';

const skipReason = flowSkipReason();

const test = base.extend<{ pipeline: FakePipeline; stack: Stack }>({
  // eslint-disable-next-line no-empty-pattern
  pipeline: async ({}, use) => use(await FakePipeline.create()),
  stack: async ({ pipeline }, use) => {
    const s = new Stack(pipeline.deps);
    await s.start();
    await use(s);
    await s.stop();
  },
  baseURL: async ({ stack }, use) => use(stack.origin),
});

test.skip(!!skipReason, skipReason ?? '');

test('[SMOKE-01] sign-up → org → meeting → upload → transcript and summary', async ({
  page,
  stack,
  pipeline,
}) => {
  const email = `smoke-${process.pid}-${Date.now()}@example.test`;
  const password = fixturePassword('smoke');
  // Surface API failures in the run log (a smoke failure is otherwise just a missing element).
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400)
      console.warn(`[smoke] ${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
  });

  // Sign up through the UI, then open the verification link the API "mailed".
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Smoke Tester');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  const token = await stack.verificationToken(email);
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByText('Your email address is verified.')).toBeVisible();

  // Log in.
  await page.goto('/login');
  if (/\/login/.test(page.url())) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  await expect(page.getByTestId('app-shell')).toBeVisible();

  // Create an organization.
  await page.goto('/organizations/new');
  await page.getByLabel('Organization name').fill('Smoke Org');
  const orgCreated = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/orgs' && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create organization' }).click();
  const orgResponse = await orgCreated;
  expect(orgResponse.status()).toBe(201);
  const orgId = ((await orgResponse.json()) as { organization: { id: string } }).organization.id;
  await expect(page.getByRole('combobox', { name: 'Organization' })).toContainText('Smoke Org');

  // Create a meeting and open it. The API has no create-meeting route yet (the web "New meeting" dialog's
  // POST /orgs/:id/meetings returns 404 at b5ea0a86), so the meeting is seeded in the in-memory repository.
  const meeting = pipeline.seedMeeting(orgId, 'Smoke kickoff');
  await page.goto('/meetings');
  await page.getByRole('link', { name: 'Smoke kickoff' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${meeting.id}$`));
  await expect(page.getByRole('heading', { name: 'Smoke kickoff', level: 1 })).toBeVisible();
  await expect(page.getByText('Transcript not available yet')).toBeVisible();

  // Upload a recording (storage PUT is stubbed), with the consent step.
  await pipeline.routeStorage(page, stack.origin);
  await page.getByTestId('upload-input').setInputFiles({
    name: 'smoke.webm',
    mimeType: 'audio/webm',
    buffer: Buffer.from('smoke-test-audio-bytes'),
  });
  await page.locator('form', { hasText: 'Recording consent' }).locator('input').first().check();
  await page.getByRole('button', { name: 'Confirm and upload' }).click();
  await expect(page.getByTestId('app-shell').getByText('Upload complete')).toBeVisible();

  // Stubbed STT + LLM pipeline, then the meeting shows the transcript and summary.
  expect(pipeline.run()).toHaveLength(1);
  await page.reload();
  await expect(page.getByText(STUB.summary)).toBeVisible();
  await expect(page.getByText(STUB.decision)).toBeVisible();
  await expect(page.getByText(STUB.action)).toBeVisible();
  const transcript = page.getByRole('list', { name: 'Transcript' });
  await expect(transcript).toContainText(STUB.speaker);
  await expect(transcript).toContainText(STUB.line);
});
