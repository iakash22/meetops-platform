/**
 * Mirrors QA E2E-10/11 (PR #57): the API is unreachable behind the same-origin
 * proxy. Uses the real API client with a stubbed fetch so the exact wire
 * responses (ECONNREFUSED, proxy 502 text, HTML 500/504 from a dev proxy) are covered.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { createApiClient } from '@/lib/api/client';
import { resetStores } from './fixtures/render';

const html = (status: number) =>
  new Response(`<!doctype html><html><body><h1>${status} Bad Gateway</h1></body></html>`, {
    status,
    headers: { 'content-type': 'text/html' },
  });

const cases: Array<[string, () => Promise<Response>]> = [
  ['ECONNREFUSED (fetch rejects)', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['aborted request', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
  [
    'proxy 502 "bad gateway" text',
    () =>
      Promise.resolve(
        new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
      ),
  ],
  ['dev proxy 500 HTML', () => Promise.resolve(html(500))],
  ['dev proxy 502 HTML', () => Promise.resolve(html(502))],
  ['dev proxy 504 HTML', () => Promise.resolve(html(504))],
  [
    '503 JSON envelope',
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'x', requestId: 'r' } }),
          { status: 503 },
        ),
      ),
  ],
];

describe('API unreachable on a signed-in page (E2E-10/11)', () => {
  beforeEach(() => resetStores(false));

  it.each(cases)('%s → /login?next=, no router error page', async (_name, respond) => {
    const fetchMock = vi.fn(() => respond());
    const api = createApiClient({ baseUrl: '/api', fetch: fetchMock });
    const history = createMemoryHistory({ initialEntries: ['/meetings'] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App queryClient={queryClient} api={api} history={history} />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(history.location.href).toBe('/login?next=%2Fmeetings');
    expect(screen.queryByText('Something went wrong!')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', expect.anything());
  });
});
