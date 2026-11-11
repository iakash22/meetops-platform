import { expect, test } from '@playwright/test';
import {
  SUMMARY,
  TASK,
  bell,
  createStore,
  expectBadgeCount,
  stubSignedInNotificationApis,
} from './notifications-stubs.js';

/**
 * N7 (docs/plans/notifications-architecture.md): Playwright e2e for the web
 * bell + notification preferences, plus a11y checks.
 *
 * The architecture sketch mentions a popover feed. The shipped UI does not
 * have one: UnreadBell is a link to the full /notifications page (covered by
 * unit tests too). These tests follow that UI. Escape-to-dismiss and returning
 * focus to the bell apply to a popover, which is not implemented; they are
 * not asserted here. Realtime `notification.new` is optional for N7 and is
 * not covered (the page is fetch/invalidation based).
 *
 * Stubs are deterministic Playwright route interception (no DB). Bodies are
 * checked with TypeBox Value.Check against @meetops/contracts (there is no
 * zod notification schema in the repo).
 */

test.describe('notifications (N7)', () => {
  test('the bell shows the unread count and the page lists notifications', async ({ page }) => {
    const store = createStore([SUMMARY, TASK]);
    await stubSignedInNotificationApis(page, store);

    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
    await expectBadgeCount(page, 2);
    const list = page.getByRole('list', { name: 'Notifications' });
    await expect(list.getByText('Summary ready: Weekly sync')).toBeVisible();
    await expect(list.getByText('You were assigned a task')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open meeting' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open tasks' })).toBeVisible();
  });

  test('mark one as read and mark all read update the list and the badge', async ({ page }) => {
    const store = createStore([SUMMARY, TASK]);
    await stubSignedInNotificationApis(page, store);

    await page.goto('/notifications');
    await expectBadgeCount(page, 2);

    await page.getByRole('button', { name: 'Mark "Summary ready: Weekly sync" read' }).click();
    await expect(page.getByRole('button', { name: /Mark "Summary/ })).toHaveCount(0);
    await expectBadgeCount(page, 1);
    expect(store.markReadCalls).toEqual([SUMMARY.id]);
    // The other item is still unread.
    await expect(page.getByRole('list', { name: 'Notifications' }).getByText('New')).toHaveCount(1);

    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
    await expectBadgeCount(page, 0);
    await expect(page.getByRole('list', { name: 'Notifications' }).getByText('New')).toHaveCount(0);
    expect(store.markAllCalls).toBe(1);
  });

  test('shows the empty state when there are no notifications', async ({ page }) => {
    await stubSignedInNotificationApis(page, createStore([]));
    await page.goto('/notifications');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByText("You're all caught up")).toBeVisible();
    await expectBadgeCount(page, 0);
    await expect(page.getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
  });

  test('shows the error state when the list request fails', async ({ page }) => {
    await stubSignedInNotificationApis(page, createStore([], { listStatus: 'error' }));
    await page.goto('/notifications');
    const error = page.getByTestId('error-state');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Something went wrong on our side. Please try again.');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Bell unread fetch also failed (retry: false); no badge.
    await expect(page.getByTestId('unread-count')).toHaveCount(0);
  });

  test('preferences toggles save, and a save error is shown without rollback', async ({ page }) => {
    const store = createStore([SUMMARY], { preferences: [] });
    await stubSignedInNotificationApis(page, store);

    await page.goto('/settings?tab=notifications');
    const form = page.getByRole('form', { name: 'Notification preferences' });
    await expect(form).toBeVisible();
    const box = page.getByRole('checkbox', { name: 'Task assigned via Email' });
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    const put = store.lastPut as { items: { type: string; channel: string; enabled: boolean }[] };
    expect(put.items).toEqual(
      expect.arrayContaining([{ type: 'task.assigned', channel: 'email', enabled: false }]),
    );

    // Save error: the panel has no rollback of local checkbox state (queries
    // only setQueryData on success). Assert the error and that the toggle stays.
    store.saveStatus = 'error';
    await box.check();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    const saveError = page.getByTestId('error-state');
    await expect(saveError).toBeVisible();
    await expect(saveError).toContainText("Couldn't save preferences");
    await expect(box).toBeChecked();
  });

  test('the bell has an accessible name and opens the list from the keyboard', async ({ page }) => {
    await stubSignedInNotificationApis(page, createStore([SUMMARY]));
    // Start on settings so activating the bell is a navigation, not a no-op.
    await page.goto('/settings?tab=notifications');
    await expect(page.getByRole('form', { name: 'Notification preferences' })).toBeVisible();
    const trigger = bell(page);
    await expect(trigger).toHaveAttribute('aria-label', 'Notifications, 1 unread');
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/notifications/);
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
    await expect(page.getByText('Summary ready: Weekly sync')).toBeVisible();
  });
});
