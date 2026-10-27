import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionSummary } from '@meetops/contracts';
import {
  countryFlag,
  formatLocation,
  isNewLocation,
  MAX_LOCATION_LENGTH,
  validCountryCode,
} from '@/features/account/session-location';
import { SessionsCard } from '@/features/account/sessions-card';
import { ApiProvider } from '@/lib/api/context';
import { createMockApi } from './fixtures/render';
import { sessionList } from './fixtures/data';

const base = sessionList.items[0]!;
const mk = (id: string, geo: Partial<SessionSummary>, current = false): SessionSummary => ({
  ...base,
  id,
  current,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
  ...geo,
});
const mumbai = {
  geoCity: 'Mumbai',
  geoRegion: 'Maharashtra',
  geoCountry: 'India',
  geoCountryCode: 'IN',
  geoApproximate: true as const,
};

describe('formatLocation fallbacks', () => {
  it('city, region, country', () =>
    expect(formatLocation(mumbai)).toBe('Mumbai, Maharashtra, India'));
  it('city, country', () =>
    expect(formatLocation({ geoCity: 'Mumbai', geoCountry: 'India' })).toBe('Mumbai, India'));
  it('region, country', () =>
    expect(formatLocation({ geoRegion: 'Maharashtra', geoCountry: 'India' })).toBe(
      'Maharashtra, India',
    ));
  it('country only', () =>
    expect(formatLocation({ geoCity: '  ', geoCountry: 'India' })).toBe('India'));
  it('unknown -> null (omitted)', () => {
    expect(formatLocation({})).toBeNull();
    expect(formatLocation({ geoCity: 'Mumbai', geoRegion: 'MH' })).toBeNull();
  });
  it('caps displayed length', () => {
    const long = 'A'.repeat(128);
    const out = formatLocation({ geoCity: long, geoRegion: long, geoCountry: long })!;
    expect(out.length).toBeLessThanOrEqual(MAX_LOCATION_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('countryFlag', () => {
  it('maps ISO alpha-2 to a flag and rejects anything else', () => {
    expect(countryFlag('in')).toBe('🇮🇳');
    expect(countryFlag('IND')).toBeNull();
    expect(countryFlag('<b>')).toBeNull();
    expect(countryFlag(null)).toBeNull();
  });
  it('accepts exactly two ASCII letters A-Z only', () => {
    expect(validCountryCode(' de ')).toBe('DE');
    for (const bad of ['', 'D', 'D1', '12', 'ÄB', 'ßa', 'ǅA', 'A\u0301', 'İS', 'ﬀ', '[x]', 'U S']) {
      expect(validCountryCode(bad)).toBeNull();
      expect(countryFlag(bad)).toBeNull();
    }
    expect(validCountryCode(undefined)).toBeNull();
  });
});

describe('isNewLocation', () => {
  const cur = mk('c', mumbai, true);
  it('flags a different country or region, never the current session or missing geo', () => {
    expect(
      isNewLocation(mk('a', { ...mumbai, geoCountryCode: 'US', geoCountry: 'USA' }), cur),
    ).toBe(true);
    expect(isNewLocation(mk('b', { ...mumbai, geoRegion: 'Karnataka' }), cur)).toBe(true);
    expect(isNewLocation(mk('d', { ...mumbai, geoCity: 'Pune' }), cur)).toBe(false);
    expect(isNewLocation(mk('e', {}), cur)).toBe(false);
    expect(isNewLocation(cur, cur)).toBe(false);
    expect(isNewLocation(mk('f', mumbai), undefined)).toBe(false);
  });
});

function renderCard(items: SessionSummary[]) {
  const api = createMockApi({
    auth: { sessions: vi.fn().mockResolvedValue({ items, nextCursor: null }) },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider client={api}>
        <SessionsCard />
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe('SessionsCard location', () => {
  it('shows device · location, flag, approximate hint and the New location badge', async () => {
    renderCard([
      mk('c', mumbai, true),
      mk('x', { geoCountry: 'Germany', geoCountryCode: 'DE', geoApproximate: true }),
      mk('y', { geoCountryCode: 'ZZZ' }),
    ]);
    const rows = await screen.findAllByTestId('session-row');
    expect(
      within(rows[0]!).getByText('Chrome on Windows · Mumbai, Maharashtra, India'),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('img', { name: 'IN' })).toHaveTextContent('🇮🇳');
    expect(
      within(rows[0]!).getByTitle('Approximate location based on IP address'),
    ).toBeInTheDocument();
    expect(within(rows[0]!).queryByTestId('new-location')).toBeNull();
    expect(within(rows[1]!).getByTestId('new-location')).toHaveTextContent('New location');
    // DB-IP attribution wherever a location is shown.
    for (const r of [rows[0]!, rows[1]!]) {
      const a = within(r).getByRole('link', { name: 'IP geolocation by DB-IP' });
      expect(a).toHaveAttribute('href', 'https://db-ip.com');
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // Invalid code + unknown location: no flag, no raw code, no location, hint or attribution.
    expect(within(rows[2]!).queryByText(/ZZZ/)).toBeNull();
    expect(within(rows[2]!).queryByRole('img')).toBeNull();
    expect(within(rows[2]!).getByText('Chrome on Windows')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(/Unknown location/)).toBeNull();
    expect(within(rows[2]!).queryByTitle(/Approximate/)).toBeNull();
    expect(within(rows[2]!).queryByTestId('dbip-attribution')).toBeNull();
  });

  it('invalid country code with a known location: location shown, no flag, no raw code', async () => {
    renderCard([
      mk('c', { geoCountry: 'India', geoCountryCode: 'I1', geoApproximate: true }, true),
    ]);
    const [row] = await screen.findAllByTestId('session-row');
    expect(within(row!).getByText('Chrome on Windows · India')).toBeInTheDocument();
    expect(within(row!).queryByRole('img')).toBeNull();
    expect(within(row!).queryByText(/I1/)).toBeNull();
    expect(within(row!).getByTestId('dbip-attribution')).toBeInTheDocument();
  });

  it('renders geo values as plain text (no HTML injection)', async () => {
    const { container } = renderCard([
      mk('c', { geoCity: '<img src=x onerror=alert(1)>', geoCountry: 'India' }, true),
    ]);
    expect(
      await screen.findByText('Chrome on Windows · <img src=x onerror=alert(1)>, India'),
    ).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
