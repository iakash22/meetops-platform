import { expect, type Page, type Route } from '@playwright/test';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  CsrfResponse,
  GetAuthSessionResponse,
  MarkNotificationsReadResponse,
  NotificationList,
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
  type Notification,
  type NotificationPreference,
} from '@meetops/contracts';

/** Same org/user UUIDs as the web unit-test fixtures. */
export const ORG_ID = '00000000-0000-4000-8000-000000000001';
export const CSRF_TOKEN = 'e2e-csrf-token-ok'; // 16+ chars (CsrfResponse)

const T = '2026-10-27T10:00:00.000Z';

export const SESSION = {
  user: {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'ada@example.com',
    name: 'Ada',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  activeOrganizationId: ORG_ID,
  role: 'owner' as const,
  organizations: [
    {
      id: ORG_ID,
      name: 'Acme Inc',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

export function unreadNotification(
  overrides: Partial<Notification> & Pick<Notification, 'id' | 'kind' | 'title'>,
): Notification {
  return {
    organizationId: ORG_ID,
    readAt: null,
    createdAt: T,
    ...overrides,
  };
}

export const SUMMARY: Notification = unreadNotification({
  id: '40000000-0000-4000-8000-000000000001',
  kind: 'report.ready',
  title: 'Summary ready: Weekly sync',
  body: 'Your AI summary is ready to review.',
  meetingId: '20000000-0000-4000-8000-000000000001',
});

export const TASK: Notification = unreadNotification({
  id: '40000000-0000-4000-8000-000000000002',
  kind: 'task.assigned',
  title: 'You were assigned a task',
  taskId: '30000000-0000-4000-8000-000000000001',
});

function assertValid(schema: TSchema, value: unknown, label: string): void {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)].slice(0, 5);
    throw new Error(`${label} failed contract validation: ${JSON.stringify(first)}`);
  }
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function problem(route: Route, status: number, code: string, message: string): Promise<void> {
  return json(route, status, { error: { code, message, requestId: 'req_e2e_notif' } });
}

export type NotificationStore = {
  items: Notification[];
  listStatus: 'ok' | 'error';
  saveStatus: 'ok' | 'error';
  preferences: NotificationPreference[];
  markReadCalls: string[];
  markAllCalls: number;
  lastPut: unknown;
};

export function createStore(
  items: Notification[],
  extras: Partial<Pick<NotificationStore, 'listStatus' | 'saveStatus' | 'preferences'>> = {},
): NotificationStore {
  return {
    items: items.map((n) => ({ ...n })),
    listStatus: 'ok',
    saveStatus: 'ok',
    preferences: [],
    markReadCalls: [],
    markAllCalls: 0,
    lastPut: undefined,
    ...extras,
  };
}

function listBody(store: NotificationStore, unreadOnly: boolean) {
  const items = unreadOnly ? store.items.filter((n) => !n.readAt) : store.items;
  const body = { items, nextCursor: null };
  assertValid(NotificationList, body, unreadOnly ? 'unread NotificationList' : 'NotificationList');
  return body;
}

/**
 * Signed-in notification APIs, plus session/csrf so the app shell can load.
 * Unstubbed /api calls 404 so they cannot hang on the Vite preview proxy.
 */
export async function stubSignedInNotificationApis(
  page: Page,
  store: NotificationStore,
): Promise<void> {
  assertValid(GetAuthSessionResponse, SESSION, 'GetAuthSessionResponse');
  assertValid(CsrfResponse, { csrfToken: CSRF_TOKEN }, 'CsrfResponse');

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();

    if (method === 'GET' && path === '/auth/csrf') {
      await json(route, 200, { csrfToken: CSRF_TOKEN });
      return;
    }
    if (method === 'GET' && path === '/auth/session') {
      await json(route, 200, SESSION);
      return;
    }

    const notificationsBase = `/orgs/${ORG_ID}/notifications`;
    const preferencesPath = `/orgs/${ORG_ID}/notification-preferences`;

    if (method === 'GET' && path === notificationsBase) {
      if (store.listStatus === 'error') {
        await problem(route, 500, 'INTERNAL', 'unavailable');
        return;
      }
      await json(route, 200, listBody(store, url.searchParams.get('unreadOnly') === 'true'));
      return;
    }

    if (method === 'POST' && path === `${notificationsBase}/read-all`) {
      store.markAllCalls += 1;
      const updated = store.items.filter((n) => !n.readAt).length;
      store.items = store.items.map((n) =>
        n.readAt ? n : { ...n, readAt: '2026-10-27T11:00:00.000Z' },
      );
      const body = { updated };
      assertValid(MarkNotificationsReadResponse, body, 'MarkNotificationsReadResponse');
      await json(route, 200, body);
      return;
    }

    const oneRead = path.match(new RegExp(`^${notificationsBase}/([^/]+)/read$`));
    if (method === 'POST' && oneRead) {
      const id = oneRead[1]!;
      store.markReadCalls.push(id);
      const target = store.items.find((n) => n.id === id);
      const updated = target && !target.readAt ? 1 : 0;
      store.items = store.items.map((n) =>
        n.id === id && !n.readAt ? { ...n, readAt: '2026-10-27T11:00:00.000Z' } : n,
      );
      const body = { updated };
      assertValid(MarkNotificationsReadResponse, body, 'MarkNotificationsReadResponse');
      await json(route, 200, body);
      return;
    }

    if (path === preferencesPath) {
      if (method === 'GET') {
        const body = { items: store.preferences };
        assertValid(NotificationPreferences, body, 'NotificationPreferences');
        await json(route, 200, body);
        return;
      }
      if (method === 'PUT') {
        const payload = route.request().postDataJSON() as unknown;
        store.lastPut = payload;
        assertValid(
          UpdateNotificationPreferencesRequest,
          payload,
          'UpdateNotificationPreferencesRequest',
        );
        if (store.saveStatus === 'error') {
          await problem(route, 500, 'INTERNAL', 'save failed');
          return;
        }
        const body = payload as { items: NotificationPreference[] };
        store.preferences = body.items;
        assertValid(NotificationPreferences, body, 'saved NotificationPreferences');
        await json(route, 200, body);
        return;
      }
    }

    await problem(route, 404, 'NOT_FOUND', 'not stubbed');
  });
}

export function bell(page: Page) {
  return page.getByRole('banner').getByRole('link', { name: /Notifications/ });
}

export async function expectBadgeCount(page: Page, count: number): Promise<void> {
  const badge = page.getByTestId('unread-count');
  if (count <= 0) {
    await expect(badge).toHaveCount(0);
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications');
    return;
  }
  const shown = count > 99 ? '99+' : String(count);
  await expect(badge).toHaveText(shown);
  await expect(bell(page)).toHaveAttribute('aria-label', `Notifications, ${shown} unread`);
}
