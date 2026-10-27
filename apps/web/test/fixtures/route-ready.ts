import { act, screen, waitFor } from '@testing-library/react';
import { expect, type Mock } from 'vitest';

/**
 * Wait for a guarded route to be ready in deterministic stages instead of one
 * findBy spanning the whole cold-start chain (guard beforeLoad -> session ->
 * AppShell -> page query), which can exceed findBy's default timeout under load.
 *
 * 1. the AppShell is mounted (guard resolved),
 * 2. optionally the page heading is rendered,
 * 3. the page's mocked API call has happened and its promise has settled.
 */
export async function waitForRouteData(
  apiCall: unknown,
  { heading }: { heading?: string } = {},
): Promise<void> {
  await screen.findByTestId('app-shell');
  if (heading) await screen.findByRole('heading', { name: heading });
  const mock = apiCall as Mock;
  await waitFor(() => expect(mock).toHaveBeenCalled());
  await act(async () => {
    // Settle the mocked promise; rejections are asserted by the caller.
    await Promise.resolve(mock.mock.results.at(-1)?.value).catch(() => undefined);
  });
}

/** api.request calls other than the top-bar unread-notifications poll (shell-wide). */
export function nonNotificationCalls(request: unknown): unknown[][] {
  const calls = (request as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter(([, path]) => !String(path).includes('/notifications'));
}
