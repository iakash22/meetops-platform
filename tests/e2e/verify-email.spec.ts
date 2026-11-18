import { expect, test, type Page, type Route } from '@playwright/test';

/** 32-char fake mail-link token (API minimum). Not a real secret. */
const TOKEN = 'e2e-verify-token-xxxxxxxxxxxxxxx';

async function stubSignedOutApis(
  page: Page,
  onVerify?: (route: Route) => Promise<void> | void,
): Promise<void> {
  // One handler so unmocked /api calls cannot hang on the Vite proxy.
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'GET' && url.includes('/auth/csrf')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ csrfToken: 'e2e-csrf-token-xx' }),
      });
      return;
    }
    if (method === 'GET' && url.includes('/auth/session')) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
            requestId: 'e2e-request-id',
          },
        }),
      });
      return;
    }
    if (method === 'GET' && url.includes('/auth/providers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ google: false }),
      });
      return;
    }
    if (method === 'POST' && url.includes('/auth/verify-email') && onVerify) {
      await onVerify(route);
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'not stubbed', requestId: 'e2e-request-id' },
      }),
    });
  });
}

function fulfillVerifyOutcome(route: Route, outcome: string | null): Promise<void> {
  return route.fulfill({
    status: 204,
    headers: outcome ? { 'x-meetops-verify-outcome': outcome } : {},
    body: '',
  });
}

function fulfillProblem(
  route: Route,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: extraHeaders,
    body: JSON.stringify({ error: { code, message, requestId: 'e2e-request-id' } }),
  });
}

test.describe('/verify-email', () => {
  test('does not verify on load; a verified outcome lets the user continue to log in', async ({
    page,
  }) => {
    const posts: string[] = [];
    await stubSignedOutApis(page, async (route) => {
      posts.push(route.request().postData() ?? '');
      await fulfillVerifyOutcome(route, 'verified');
    });

    await page.goto(`/verify-email?token=${TOKEN}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Verify your email' })).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Verify email' });
    await expect(confirm).toBeVisible();
    expect(posts).toEqual([]);

    await confirm.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Your email address is verified.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue to log in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(TOKEN);
  });

  test('password_reset says the password was removed and links to forgot-password', async ({
    page,
  }) => {
    await stubSignedOutApis(page, (route) => fulfillVerifyOutcome(route, 'password_reset'));

    await page.goto(`/verify-email?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Verify email' }).click();

    const status = page.getByRole('status').filter({
      hasText: 'the password on this account was removed',
    });
    await expect(status).toBeVisible();
    await expect(status).toContainText('Set a new one with the link we just emailed you');
    await expect(page.getByText('You can log in now.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continue to log in' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Send a new set-password link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Verify your email' })).toBeVisible();
  });

  test('set_password tells the user to set a password and never says it was removed', async ({
    page,
  }) => {
    await stubSignedOutApis(page, (route) => fulfillVerifyOutcome(route, 'set_password'));

    await page.goto(`/verify-email?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Verify email' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: 'set one with the link we just emailed you' }),
    ).toBeVisible();
    await expect(page.getByText(/removed/i)).toHaveCount(0);
    await expect(page.getByText('You can log in now.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Send a new set-password link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  test('a missing token shows the incomplete-link problem, not a verify button', async ({
    page,
  }) => {
    await stubSignedOutApis(page);

    await page.goto('/verify-email');
    await expect(page.getByRole('heading', { level: 1, name: 'Verify your email' })).toBeVisible();
    const problem = page.getByRole('alert');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText('This verification link is incomplete');
    // Problem is a role=alert box; it is not auto-focused in the current UI.
    await expect(page.getByRole('button', { name: 'Verify email' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Send a new verification link' })).toHaveAttribute(
      'href',
      '/resend-verification',
    );
  });

  test('an invalid or expired token (400) shows the problem UI and a resend link', async ({
    page,
  }) => {
    await stubSignedOutApis(page, (route) =>
      fulfillProblem(route, 400, 'BAD_REQUEST', 'Verification link is invalid or has expired'),
    );

    await page.goto(`/verify-email?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Verify email' }).click();

    const problem = page.getByRole('alert');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText('This verification link is invalid or has expired');
    await expect(page.getByRole('link', { name: 'Send a new verification link' })).toHaveAttribute(
      'href',
      '/resend-verification',
    );
    await expect(page).toHaveURL(/\/verify-email/);
  });

  test('a pre-commit 503 keeps the confirm button and shows a retryable toast', async ({
    page,
  }) => {
    await stubSignedOutApis(page, (route) =>
      fulfillProblem(
        route,
        503,
        'PROVIDER_UNAVAILABLE',
        'Service temporarily unavailable, try again later',
        { 'Retry-After': '5' },
      ),
    );

    await page.goto(`/verify-email?token=${TOKEN}`);
    await page.getByRole('button', { name: 'Verify email' }).click();

    const toast = page.getByRole('alert');
    await expect(toast).toContainText("Can't reach MeetOps right now");
    await expect(page.getByTestId('link-problem')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Verify email' })).toBeVisible();
  });
});
