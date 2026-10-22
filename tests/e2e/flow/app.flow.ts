import {
  expect,
  request as pwRequest,
  test as base,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { fixturePassword } from '../../support/fixture-secrets.js';
import { flowSkipReason, Stack } from './stack.js';

const skipReason = flowSkipReason();

type Fixtures = { stack: Stack; api: Api };

/** API client for test setup (same origin as the web app, through the proxy). */
class Api {
  constructor(
    readonly ctx: APIRequestContext,
    readonly origin: string,
  ) {}
  private async csrf(): Promise<string> {
    const r = await this.ctx.get('/api/auth/csrf');
    expect(r.status(), 'GET /auth/csrf').toBe(200);
    return ((await r.json()) as { csrfToken: string }).csrfToken;
  }
  async post(path: string, data: unknown, withCsrf = true) {
    const headers: Record<string, string> = { origin: this.origin };
    if (withCsrf) headers['x-csrf-token'] = await this.csrf();
    return this.ctx.post(`/api${path}`, { data, headers });
  }
  async signup(email: string, password: string) {
    const r = await this.post('/auth/signup', { name: 'QA E2E', email, password });
    expect([200, 201, 202], `signup status ${r.status()}`).toContain(r.status());
  }
  async login(email: string, password: string) {
    const r = await this.post('/auth/login', { email, password });
    expect(r.status(), 'login').toBe(200);
  }
  async createOrg(name: string): Promise<{ id: string; name: string }> {
    const r = await this.post('/orgs', { name });
    expect(r.status(), `POST /orgs: ${await r.text()}`).toBe(201);
    return ((await r.json()) as { organization: { id: string; name: string } }).organization;
  }
}

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  stack: async ({}, use) => {
    const s = new Stack();
    await s.start();
    await use(s);
    await s.stop();
  },
  api: async ({ stack }, use) => {
    const ctx = await pwRequest.newContext({ baseURL: stack.origin });
    await use(new Api(ctx, stack.origin));
    await ctx.dispose();
  },
  baseURL: async ({ stack }, use) => use(stack.origin),
});

test.skip(!!skipReason, skipReason ?? '');

let n = 0;
const newEmail = () => `qa-e2e-${process.pid}-${Date.now()}-${n++}@example.test`;
const PASSWORD = fixturePassword('e2e');

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** User with `orgs` organizations created through the real API. */
async function seedUser(api: Api, orgNames: string[]) {
  const email = newEmail();
  await api.signup(email, PASSWORD);
  await api.login(email, PASSWORD);
  const orgs = [];
  for (const name of orgNames) orgs.push(await api.createOrg(name));
  return { email, orgs };
}

test.describe('web flow (PR #48 web + createServer API)', () => {
  test('[E2E-01] unauthenticated visit to /meetings redirects to /login?next=', async ({
    page,
  }) => {
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=%2Fmeetings/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('[E2E-02] login with a real account lands in the app shell', async ({ page, api }) => {
    const { email } = await seedUser(api, ['Acme QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('[E2E-03] wrong password shows an error and stays on /login', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, fixturePassword('e2e-wrong'));
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('[E2E-04] login honours a same-origin ?next= after the redirect', async ({ page, api }) => {
    // FE-BUG-1 (PR #48): after a guard redirect caches session=null, a successful login does
    // not refetch /auth/session (ensureQueryData returns the stale null), so the guard bounces
    // the user back to /login?next=... Login itself succeeds (a reload shows the session).
    test.fail(true, 'FE-BUG-1: login after a guard redirect bounces back to /login');
    const { email } = await seedUser(api, ['Next QA']);
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/meetings$/);
  });

  test('[E2E-05] org switcher lists the orgs created via the API and switches the org scope', async ({
    page,
    api,
  }) => {
    const { email, orgs } = await seedUser(api, ['Alpha QA', 'Beta QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    const switcher = page.getByRole('combobox', { name: 'Organization' });
    await expect(switcher).toHaveText(/Alpha QA|Beta QA/);
    const active = (await switcher.innerText()).includes('Alpha QA') ? 0 : 1;
    const other = orgs[1 - active]!;
    await page.goto('/meetings');
    await expect(page.getByRole('heading', { name: 'Meetings' })).toBeVisible();
    const otherMeetings = page.waitForRequest((r) =>
      r.url().includes(`/api/orgs/${other.id}/meetings`),
    );
    await switcher.click();
    await expect(page.getByRole('option')).toHaveText(['Alpha QA', 'Beta QA']);
    await page.getByRole('option', { name: other.name }).click();
    await expect(switcher).toContainText(other.name);
    await otherMeetings;
  });

  test('[E2E-06] user without organizations sees a disabled switcher', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Organization' })).toBeDisabled();
  });

  test.fixme('[E2E-07] create an organization from the web UI', // FE-GAP-1: PR #48 has no create-organization UI (only the switcher); API POST /orgs exists.
  async () => {});

  test('[E2E-08] meetings list renders contract-shaped data (meetings API stubbed in tests/)', async ({
    page,
    api,
  }) => {
    const { email, orgs } = await seedUser(api, ['Meet QA']);
    const org = orgs[0]!;
    const T = new Date().toISOString();
    await page.route(`**/api/orgs/${org.id}/meetings`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: crypto.randomUUID(),
              organizationId: org.id,
              title: 'Weekly sync QA',
              source: 'upload',
              status: 'completed',
              startedAt: T,
              endedAt: T,
              createdById: crypto.randomUUID(),
              createdAt: T,
              updatedAt: T,
            },
            {
              id: crypto.randomUUID(),
              organizationId: org.id,
              title: 'Planning QA',
              source: 'extension',
              status: 'recording',
              startedAt: T,
              createdById: crypto.randomUUID(),
              createdAt: T,
              updatedAt: T,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.goto('/meetings');
    await expect(page.getByRole('link', { name: 'Weekly sync QA' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Planning QA' })).toBeVisible();
    await expect(page.getByTestId('meeting-status')).toHaveCount(2);
  });

  test('[E2E-09] meetings list against the real API shows the empty state', async ({
    page,
    api,
  }) => {
    // BE-GAP-1: the API (integration/phase-1) has no GET /orgs/:id/meetings yet, so this fails
    // with the error state until Backend ships the endpoint. Left failing on purpose.
    test.fail(true, 'BE-GAP-1: GET /orgs/:id/meetings not implemented in the API');
    const { email } = await seedUser(api, ['Empty QA']);
    await uiLogin(page, email, PASSWORD);
    await page.goto('/meetings');
    await expect(page.getByText('No meetings yet')).toBeVisible({ timeout: 5000 });
  });

  test('[E2E-10] signed-in page redirects to /login when API requests are aborted', async ({
    page,
    api,
  }) => {
    // FE-BUG-2 (PR #48): a network failure on GET /auth/session is not a 401, so the guard's
    // beforeLoad throws and the router shows its default "Something went wrong!" page at the
    // protected URL instead of redirecting to /login.
    test.fail(true, 'FE-BUG-2: API unreachable shows the router error page, not /login');
    const { email } = await seedUser(api, ['Abort QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('[E2E-11] signed-in page redirects to /login when the API is stopped', async ({
    page,
    api,
    stack,
  }) => {
    // FE-BUG-2 (PR #48): a network failure on GET /auth/session is not a 401, so the guard's
    // beforeLoad throws and the router shows its default "Something went wrong!" page at the
    // protected URL instead of redirecting to /login.
    test.fail(true, 'FE-BUG-2: API unreachable shows the router error page, not /login');
    const { email } = await seedUser(api, ['Stop QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await stack.stopApi();
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
