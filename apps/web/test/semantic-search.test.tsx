import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResponse, SemanticSearchResponse } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import {
  createHttpSearchApi,
  semanticKindFor,
  setSearchApiOverride,
  type SearchApi,
} from '@/features/search/api';
import { renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const MEETING = '80000000-0000-4000-8000-000000000001';
const T = '2026-10-01T00:00:00.000Z';

const keyword: SearchResponse = {
  items: [
    {
      kind: 'meeting',
      id: MEETING,
      meetingId: MEETING,
      title: 'Keyword hit',
      snippet: 'billing',
      rank: 1,
      occurredAt: T,
    },
  ],
};
const semanticRes: SemanticSearchResponse = {
  items: [
    {
      kind: 'summary',
      id: '90000000-0000-4000-8000-000000000001',
      meetingId: MEETING,
      title: 'Semantic hit',
      snippet: '<b>not html</b>',
      score: 0.82,
      occurredAt: T,
    },
  ],
};

function mockApi(impl: SearchApi['semantic']) {
  const semantic = vi.fn(impl);
  const api: SearchApi = { search: vi.fn().mockResolvedValue(keyword), semantic };
  return { api, semantic };
}

describe('semantic search client', () => {
  it('GETs the contract path and only sends kinds for a subset', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const api = createHttpSearchApi(request);
    await api.semantic(ORG, 'launch plan');
    await api.semantic(ORG, 'launch plan', ['summary']);
    await api.semantic(ORG, 'x'.repeat(600), ['summary', 'transcript']);
    expect(request.mock.calls[0]).toEqual(['GET', `/orgs/${ORG}/search/semantic?q=launch+plan`]);
    expect(String(request.mock.calls[1]?.[1])).toBe(
      `/orgs/${ORG}/search/semantic?q=launch+plan&kinds=summary`,
    );
    expect(
      new URLSearchParams(String(request.mock.calls[2]?.[1]).split('?')[1]).get('q'),
    ).toHaveLength(500);
    expect(String(request.mock.calls[2]?.[1])).not.toContain('kinds=');
  });

  it('maps keyword kinds to semantic kinds', () => {
    expect(semanticKindFor(undefined)).toBe('all');
    expect(semanticKindFor('transcript')).toBe('transcript');
    expect(semanticKindFor('meeting')).toBeNull();
    expect(semanticKindFor('task')).toBeNull();
  });
});

describe('/search semantic toggle', () => {
  beforeEach(() => resetStores());
  afterEach(() => setSearchApiOverride(null));

  it('is off by default and uses keyword search', async () => {
    const { api, semantic } = mockApi(() => Promise.resolve(semanticRes));
    setSearchApiOverride(api);
    renderApp('/search?q=billing');
    await screen.findByRole('list', { name: 'Search results' });
    expect(screen.getByRole('button', { name: 'Semantic' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(semantic).not.toHaveBeenCalled();
  });

  it('shows semantic results as plain text when the feature is on', async () => {
    const { api, semantic } = mockApi(() => Promise.resolve(semanticRes));
    setSearchApiOverride(api);
    renderApp('/search?q=billing');
    await userEvent.click(await screen.findByRole('button', { name: 'Semantic' }));
    const list = await screen.findByRole('list', { name: 'Semantic results' });
    expect(within(list).getByText('Semantic hit')).toBeInTheDocument();
    expect(within(list).getByText('<b>not html</b>')).toBeInTheDocument();
    expect(within(list).getByRole('link')).toHaveAttribute('href', `/meetings/${MEETING}`);
    expect(semantic).toHaveBeenCalledWith(ORG, 'billing', undefined);
  });

  it('falls back to keyword search, without retrying, when the API returns 404', async () => {
    const { api, semantic } = mockApi(() =>
      Promise.reject(new ApiError(404, 'NOT_FOUND', 'off', 'r1')),
    );
    setSearchApiOverride(api);
    renderApp('/search?q=billing');
    await screen.findByRole('list', { name: 'Search results' });
    await userEvent.click(screen.getByRole('button', { name: 'Semantic' }));
    expect(await screen.findByText(/isn.t enabled on this workspace/)).toBeInTheDocument();
    expect(await screen.findByText('Keyword hit')).toBeInTheDocument();
    await waitFor(() => expect(semantic).toHaveBeenCalledTimes(1));
  });

  it('uses keyword search for kinds semantic search does not cover', async () => {
    const { api, semantic } = mockApi(() => Promise.resolve(semanticRes));
    setSearchApiOverride(api);
    renderApp('/search?q=billing&kind=task');
    await userEvent.click(await screen.findByRole('button', { name: 'Semantic' }));
    expect(await screen.findByText(/covers transcripts and summaries/)).toBeInTheDocument();
    expect(semantic).not.toHaveBeenCalled();
  });
});
